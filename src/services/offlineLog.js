'use strict';

/**
 * Serialisasi & idempotensi Offline_Log_Queue — Smart Door KOS ESP32.
 *
 * Modul logika murni (tanpa I/O, tanpa dependensi hardware) yang menangani
 * format antrean `offline_logs.jsonl` (append-only, satu JSON per baris).
 * Modul ini juga menjadi referensi portabel bagi lapisan offline-log firmware
 * (Task 22.2) sehingga server dan firmware memakai aturan serialisasi,
 * pruning ber-ACK, dan deduplikasi idempotency yang identik.
 *
 * Model event log (lihat Data Models "offline_logs.jsonl" di design.md):
 *   {
 *     "id":            "dev01-000017",          // idempotency key = deviceId + "-" + counterMonotonikPersisten
 *     "ts":            "2025-06-18T09:12:03Z",  // ISO-8601 UTC dari RTC DS3231
 *     "uid":           "04A2B3C4D5",            // UID kartu
 *     "result":        "GRANT" | "DENY",        // hasil keputusan akses
 *     "sync_type":     "CACHED_OFFLINE",        // sumber log (Req 15)
 *     "ts_unverified": 0 | 1                    // opsional: timestamp tak terverifikasi (Req 5.5)
 *   }
 *
 * Identitas log memakai `idempotency_key` (field `id`). Server melakukan
 * `INSERT ... ON CONFLICT(idempotency_key) DO NOTHING` sehingga pengiriman
 * ulang tidak menduplikasi (Req 19.3), dan ACK mengembalikan daftar id yang
 * tersimpan agar firmware hanya menghapus entri yang pasti ter-ACK (Req 6.3).
 *
 * _Requirements: 5.1, 6.2, 6.3, 6.4, 19.2, 19.3_
 */

/**
 * Ambil kunci identitas (idempotency key) dari sebuah event log.
 * Field kanonis adalah `id`; `idempotency_key` diterima sebagai alias agar
 * modul toleran terhadap kedua penamaan (server memakai `idempotency_key`).
 * @param {object} event event log.
 * @returns {string|undefined} kunci identitas, bila ada.
 */
function identityKey(event) {
  if (!event || typeof event !== 'object') {
    return undefined;
  }
  if (event.id != null) {
    return event.id;
  }
  if (event.idempotency_key != null) {
    return event.idempotency_key;
  }
  return undefined;
}

/**
 * Serialkan satu event log menjadi satu baris JSONL (tanpa newline tersemat).
 *
 * Properti kunci: `serialize` lalu `parse` menghasilkan event yang setara
 * (round-trip; Property 8). Field `ts_unverified` dipertahankan apa adanya
 * bila ada (Req 5.5) dan tidak ditambahkan bila memang tidak diset.
 *
 * @param {object} event event log (lihat bentuk di dokumentasi modul).
 * @returns {string} satu baris JSON (dijamin tanpa karakter newline).
 * @throws {TypeError} bila event bukan objek, atau hasil JSON mengandung newline.
 */
function serialize(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('serialize: event harus berupa objek');
  }
  // JSON.stringify tidak pernah menyisipkan newline literal; nilai string
  // yang mengandung '\n' akan ter-escape menjadi "\\n" sehingga baris tetap
  // utuh (tahan korupsi parsial: satu kejadian = satu baris).
  const line = JSON.stringify(event);
  if (line.indexOf('\n') !== -1 || line.indexOf('\r') !== -1) {
    // Pertahanan ekstra; secara teori tidak tercapai dengan JSON.stringify.
    throw new TypeError('serialize: baris JSONL tidak boleh memuat newline');
  }
  return line;
}

/**
 * Parse satu baris JSONL kembali menjadi event log.
 * Round-trip setara dengan {@link serialize}.
 *
 * @param {string} line satu baris JSONL (boleh diakhiri newline/whitespace).
 * @returns {object} event log hasil parse.
 * @throws {TypeError} bila line bukan string.
 * @throws {SyntaxError} bila line bukan JSON objek yang valid.
 */
function parse(line) {
  if (typeof line !== 'string') {
    throw new TypeError('parse: line harus berupa string');
  }
  const trimmed = line.trim();
  const value = JSON.parse(trimmed);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SyntaxError('parse: baris JSONL harus berupa objek JSON');
  }
  return value;
}

/**
 * Normalisasi daftar id ber-ACK menjadi Set untuk pencarian O(1).
 * Menerima array id, satu id tunggal (string), atau Set.
 * @param {Array<string>|Set<string>|string} ackedIds
 * @returns {Set<string>}
 */
function toAckedSet(ackedIds) {
  if (ackedIds == null) {
    return new Set();
  }
  if (ackedIds instanceof Set) {
    return ackedIds;
  }
  if (Array.isArray(ackedIds)) {
    return new Set(ackedIds);
  }
  return new Set([ackedIds]);
}

/**
 * Buang dari antrean tepat entri yang id-nya (idempotency key) ber-ACK.
 *
 * Mengembalikan antrean BARU (tidak memutasi input). Entri yang id-nya ada
 * di `ackedIds` dihapus; entri lain dipertahankan pada urutan semula. Entri
 * tanpa identitas yang dapat dikenali selalu dipertahankan.
 *
 * Properti kunci (Property 9): hasil = antrean awal − id ber-ACK, tepat.
 *
 * @param {Array<object>} queue antrean event log (tidak dimutasi).
 * @param {Array<string>|Set<string>|string} ackedIds id-id yang telah di-ACK.
 * @returns {Array<object>} antrean baru tanpa entri ber-ACK.
 * @throws {TypeError} bila queue bukan array.
 */
function pruneAcked(queue, ackedIds) {
  if (!Array.isArray(queue)) {
    throw new TypeError('pruneAcked: queue harus berupa array');
  }
  const acked = toAckedSet(ackedIds);
  if (acked.size === 0) {
    // Tidak ada yang di-ACK → salin dangkal agar tetap tidak memutasi input.
    return queue.slice();
  }
  return queue.filter((event) => {
    const key = identityKey(event);
    // Entri tanpa identitas tidak mungkin ber-ACK → pertahankan.
    if (key == null) {
      return true;
    }
    return !acked.has(key);
  });
}

/**
 * Deduplikasi daftar log berdasarkan `idempotency_key` (field `id`),
 * mempertahankan kemunculan PERTAMA untuk setiap kunci unik.
 *
 * Properti kunci (mendukung Property 10): jumlah entri hasil sama dengan
 * jumlah key unik pada input. Entri tanpa identitas tidak pernah dianggap
 * duplikat dan selalu dipertahankan (urutan asli dijaga).
 *
 * @param {Array<object>} logs daftar event log (boleh memuat key duplikat).
 * @returns {Array<object>} daftar log unik per idempotency key.
 * @throws {TypeError} bila logs bukan array.
 */
function dedupeByKey(logs) {
  if (!Array.isArray(logs)) {
    throw new TypeError('dedupeByKey: logs harus berupa array');
  }
  const seen = new Set();
  const unique = [];
  for (const event of logs) {
    const key = identityKey(event);
    if (key == null) {
      // Tanpa identitas: tidak dapat dibandingkan sebagai duplikat → simpan.
      unique.push(event);
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(event);
  }
  return unique;
}

module.exports = {
  identityKey,
  serialize,
  parse,
  pruneAcked,
  dedupeByKey,
};
