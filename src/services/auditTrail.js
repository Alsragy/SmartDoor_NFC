'use strict';

/**
 * Audit Trail & Penandaan Sync_Type — Smart Door KOS ESP32 (Web Server Node.js).
 *
 * Bertanggung jawab menyimpan setiap kejadian akses ke tabel `access_logs`
 * dengan penandaan `sync_type` sesuai sumber log, serta menjamin ingest yang
 * IDEMPOTEN (pengiriman ulang tidak menduplikasi baris).
 *
 * Model (lihat design.md "Live Access Feed & Audit Trail", Req 14/15):
 *   - Setiap log masuk ditulis ke `access_logs` dengan `sync_type`:
 *       * Diterima langsung saat online (jalur live MQTT) → `REALTIME`   (Req 15.2).
 *       * Diterima dari antrean offline saat sinkronisasi  → `CACHED_OFFLINE` (Req 15.3).
 *   - Identitas log memakai `idempotency_key` (UNIQUE pada skema). Penyimpanan
 *     memakai `INSERT ... ON CONFLICT(idempotency_key) DO NOTHING` sehingga
 *     pengiriman ulang entri yang sama tidak menambah baris (Req 6.4/19.2/19.3).
 *   - ACK ingest mengembalikan daftar `accepted_ids`: hanya idempotency_key yang
 *     BENAR-BENAR baru tersimpan (bukan duplikat). Firmware memakai daftar ini
 *     untuk menghapus hanya entri yang pasti ter-ACK dari Offline_Log_Queue
 *     (Req 6.3) — entri duplikat tidak termasuk, namun aman karena sudah ada.
 *
 * Bentuk objek log yang diterima (toleran terhadap alias dari offline_logs.jsonl):
 *   {
 *     idempotency_key | id : string,   // identitas unik log (field `id` = alias)
 *     device_id             : string,  // opsional (nullable di skema)
 *     uid                   : string,  // opsional (nullable di skema)
 *     result                : "GRANT" | "DENY",
 *     ts                    : string,  // ISO-8601 UTC dari RTC firmware
 *     ts_unverified         : 0 | 1,   // opsional, default 0 (Req 5.5)
 *     sync_type             : "REALTIME" | "CACHED_OFFLINE"  // opsional; ditentukan oleh `source`
 *   }
 *
 * Catatan desain:
 *   - `source` adalah penentu KANONIK `sync_type` (Req 15.2/15.3). Nilai
 *     `sync_type` yang mungkin ada di dalam `log` diabaikan demi integritas
 *     audit: tag ditentukan oleh jalur penerimaan di server, bukan klaim klien.
 *   - Modul menerima `db` yang dapat diinjeksi (default ke instance bersama
 *     `getDb()`), sehingga uji dapat memakai `createDatabase(':memory:')`.
 *
 * _Requirements: 15.1, 15.2, 15.3, 6.4, 19.2, 19.3_
 */

const { getDb } = require('../db');
const { SYNC_TYPE, SYNC_TYPE_VALUES } = require('../constants');

/** Hasil akses (result) yang diizinkan pada skema access_logs. */
const RESULT_VALUES = Object.freeze(['GRANT', 'DENY']);

/**
 * Ambil identitas (idempotency key) dari sebuah objek log.
 * Field kanonis di server adalah `idempotency_key`; `id` diterima sebagai
 * alias agar modul toleran terhadap payload antrean offline (offline_logs.jsonl
 * memakai `id`). Lihat offlineLog.identityKey untuk aturan yang sepadan.
 * @param {object} log objek log.
 * @returns {string|undefined} idempotency key bila ada.
 */
function identityKey(log) {
  if (!log || typeof log !== 'object') {
    return undefined;
  }
  if (log.idempotency_key != null) {
    return log.idempotency_key;
  }
  if (log.id != null) {
    return log.id;
  }
  return undefined;
}

/**
 * Petakan `source` ke nilai `sync_type` kanonik.
 * Menerima penamaan source ('REALTIME'/'CACHED_OFFLINE') maupun nilai sync_type
 * langsung (keduanya identik di domain ini). Pembandingan tidak case-sensitive.
 * @param {string} source sumber log: 'REALTIME' (live online) | 'CACHED_OFFLINE' (antrean offline).
 * @returns {'REALTIME'|'CACHED_OFFLINE'} nilai sync_type tervalidasi.
 * @throws {TypeError} bila source bukan string.
 * @throws {RangeError} bila source bukan salah satu nilai yang diizinkan.
 */
function syncTypeForSource(source) {
  if (typeof source !== 'string') {
    throw new TypeError('recordLog: source wajib berupa string REALTIME | CACHED_OFFLINE');
  }
  const normalized = source.trim().toUpperCase();
  if (!SYNC_TYPE_VALUES.includes(normalized)) {
    throw new RangeError(
      `recordLog: source tidak dikenal "${source}"; harus salah satu dari ${SYNC_TYPE_VALUES.join(', ')}`
    );
  }
  return normalized;
}

/**
 * Validasi & normalisasi `result` sebuah log terhadap enum yang diizinkan.
 * @param {*} result nilai result mentah.
 * @returns {'GRANT'|'DENY'} result tervalidasi (huruf besar).
 * @throws {RangeError} bila bukan GRANT/DENY.
 */
function normalizeResult(result) {
  const normalized = typeof result === 'string' ? result.trim().toUpperCase() : result;
  if (!RESULT_VALUES.includes(normalized)) {
    throw new RangeError(
      `recordLog: result tidak valid "${result}"; harus salah satu dari ${RESULT_VALUES.join(', ')}`
    );
  }
  return normalized;
}

/**
 * Normalisasi flag `ts_unverified` ke 0 atau 1 (Req 5.5). Default 0 bila absen.
 * Nilai truthy selain 0/false dianggap 1 agar toleran, namun hanya 0/1 yang
 * disimpan (sesuai CHECK pada skema).
 * @param {*} value nilai mentah ts_unverified.
 * @returns {0|1}
 */
function normalizeTsUnverified(value) {
  if (value == null) {
    return 0;
  }
  return value ? 1 : 0;
}

/**
 * Siapkan baris yang akan di-INSERT dari sebuah objek log + sync_type kanonik.
 * Memvalidasi field wajib (idempotency_key, result, ts) dan menormalkan enum.
 * @param {object} log objek log sumber.
 * @param {'REALTIME'|'CACHED_OFFLINE'} syncType nilai sync_type kanonik.
 * @returns {{idempotency_key:string, device_id:?string, uid:?string, result:string, ts:string, ts_unverified:0|1, sync_type:string}}
 * @throws {TypeError|RangeError} bila log tidak valid.
 */
function prepareRow(log, syncType) {
  if (!log || typeof log !== 'object' || Array.isArray(log)) {
    throw new TypeError('recordLog: log harus berupa objek');
  }
  const idempotencyKey = identityKey(log);
  if (idempotencyKey == null || String(idempotencyKey).length === 0) {
    throw new TypeError('recordLog: log.idempotency_key (atau log.id) wajib diisi');
  }
  if (log.ts == null || String(log.ts).length === 0) {
    throw new TypeError('recordLog: log.ts wajib diisi (ISO-8601 UTC)');
  }
  return {
    idempotency_key: String(idempotencyKey),
    device_id: log.device_id != null ? String(log.device_id) : null,
    uid: log.uid != null ? String(log.uid) : null,
    result: normalizeResult(log.result),
    ts: String(log.ts),
    ts_unverified: normalizeTsUnverified(log.ts_unverified),
    sync_type: syncType,
  };
}

/** SQL INSERT idempoten: abaikan konflik pada idempotency_key (Req 19.3). */
const INSERT_SQL = `
  INSERT INTO access_logs
    (idempotency_key, device_id, uid, result, ts, ts_unverified, sync_type)
  VALUES
    (@idempotency_key, @device_id, @uid, @result, @ts, @ts_unverified, @sync_type)
  ON CONFLICT(idempotency_key) DO NOTHING
`;

/**
 * Simpan SATU log akses ke `access_logs` dengan penandaan sync_type kanonik
 * berdasar `source`, bersifat idempoten (ON CONFLICT DO NOTHING).
 *
 * @param {object} log objek log (lihat bentuk di dokumentasi modul).
 * @param {'REALTIME'|'CACHED_OFFLINE'} source sumber log; menentukan sync_type
 *   (REALTIME = jalur live online, Req 15.2; CACHED_OFFLINE = antrean offline, Req 15.3).
 * @param {import('better-sqlite3').Database} [db] instance DB (default getDb()).
 * @returns {{ accepted: boolean, idempotency_key: string, sync_type: string }}
 *   `accepted` true bila baris BARU tersimpan; false bila duplikat (no-op).
 * @throws {TypeError|RangeError} bila argumen tidak valid.
 */
function recordLog(log, source, db = getDb()) {
  const syncType = syncTypeForSource(source);
  const row = prepareRow(log, syncType);
  const info = db.prepare(INSERT_SQL).run(row);
  return {
    accepted: info.changes > 0,
    idempotency_key: row.idempotency_key,
    sync_type: syncType,
  };
}

/**
 * Simpan BANYAK log akses dalam satu transaksi atomik, idempoten per
 * idempotency_key. Mengembalikan daftar `accepted_ids` berisi HANYA
 * idempotency_key yang baru tersimpan (bukan duplikat) — mendukung ACK ingest
 * offline-log (Req 6.4/19.2/19.3): firmware hanya menghapus entri ber-ACK.
 *
 * Duplikat di dalam satu batch (idempotency_key muncul berkali-kali) hanya
 * diterima sekali: kemunculan pertama → accepted, sisanya → no-op.
 *
 * @param {Array<object>} logs daftar log.
 * @param {'REALTIME'|'CACHED_OFFLINE'} source sumber seluruh log pada batch ini.
 * @param {import('better-sqlite3').Database} [db] instance DB (default getDb()).
 * @returns {{ accepted_ids: string[] }} daftar idempotency_key yang baru tersimpan,
 *   pada urutan kemunculan di `logs`.
 * @throws {TypeError|RangeError} bila argumen tidak valid.
 */
function recordLogs(logs, source, db = getDb()) {
  if (!Array.isArray(logs)) {
    throw new TypeError('recordLogs: logs harus berupa array');
  }
  const syncType = syncTypeForSource(source);

  // Validasi & siapkan seluruh baris lebih dulu agar batch tidak sebagian
  // tersimpan akibat log yang tak valid (transaksi dibatalkan jika melempar).
  const rows = logs.map((log) => prepareRow(log, syncType));

  const stmt = db.prepare(INSERT_SQL);
  const runBatch = db.transaction((preparedRows) => {
    const acceptedIds = [];
    for (const row of preparedRows) {
      const info = stmt.run(row);
      if (info.changes > 0) {
        acceptedIds.push(row.idempotency_key);
      }
    }
    return acceptedIds;
  });

  const accepted_ids = runBatch(rows);
  return { accepted_ids };
}

module.exports = {
  recordLog,
  recordLogs,
  // Diekspos untuk keperluan uji & pemakaian lanjutan.
  identityKey,
  syncTypeForSource,
  normalizeResult,
  normalizeTsUnverified,
  RESULT_VALUES,
  SYNC_TYPE,
};
