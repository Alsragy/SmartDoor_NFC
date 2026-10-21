'use strict';

/**
 * Router ingest Offline-Log — Smart Door KOS ESP32 (Web Server Node.js).
 *
 * Mengimplementasikan endpoint sinkronisasi antrean offline firmware:
 *
 *   POST /api/devices/:dev/offline-logs
 *     body: { logs: [ { id|idempotency_key, ts, uid?, result, ts_unverified? }, ... ] }
 *     → menyimpan setiap entri ke `access_logs` via
 *       `auditTrail.recordLogs(logs, 'CACHED_OFFLINE', db)` sehingga:
 *         * setiap baris bertanda `sync_type = CACHED_OFFLINE` (Req 15.3),
 *         * ingest IDEMPOTEN lewat `ON CONFLICT(idempotency_key) DO NOTHING`
 *           (Req 6.4 / 19.2 / 19.3) — pengiriman ulang batch tidak menduplikasi.
 *     → respons 200 { accepted_ids: [...] } berisi HANYA idempotency_key yang
 *       benar-benar baru tersimpan, agar firmware menghapus hanya entri ter-ACK
 *       dari Offline_Log_Queue (Req 6.3). Pengiriman ulang batch yang sama
 *       mengembalikan accepted_ids=[] pada panggilan kedua.
 *
 * Catatan integritas referensial (FK) — ingest tidak boleh gagal karena FK:
 *   - `access_logs.device_id` → `devices.device_id`
 *   - `access_logs.uid`       → `cards.uid`
 *   Firmware mengirim UID kartu mentah yang mungkin BELUM terdaftar sebagai
 *   `cards` (mis. tap kartu tak dikenal yang menghasilkan DENY). Agar ingest
 *   tahan-banting dan audit tidak pernah ditolak oleh FK:
 *     * `device_id` diambil dari parameter :dev lalu disimpan apa adanya BILA
 *       device tersebut ada; bila tidak ada → disimpan NULL.
 *     * `uid` disimpan BILA cocok dengan `cards.uid` yang ada; bila tidak →
 *       disimpan NULL (histori tetap tercatat lewat idempotency_key + result).
 *   Pendekatan ini sejalan dengan skema (kedua kolom nullable, ON DELETE SET
 *   NULL) sehingga histori audit tidak pernah hilang/ditolak.
 *
 * Keamanan: route ini DIPROTEKSI oleh middleware `apiKey` saat di-mount (task
 * 18) — modul ini tidak memasang middleware apa pun sendiri.
 *
 * `db` dapat diinjeksi (default instance bersama `getDb()`) agar dapat diuji
 * dengan `createDatabase(':memory:')`.
 *
 * _Requirements: 6.4, 15.3, 19.2, 19.3_
 */

const express = require('express');
const { getDb } = require('../db');
const auditTrail = require('../services/auditTrail');
const { SYNC_TYPE } = require('../constants');

/**
 * Tentukan apakah sebuah device_id sudah terdaftar pada tabel `devices`.
 * @param {import('better-sqlite3').Database} db
 * @param {string} deviceId
 * @returns {boolean}
 */
function deviceExists(db, deviceId) {
  const row = db.prepare('SELECT 1 FROM devices WHERE device_id = ? LIMIT 1').get(deviceId);
  return row != null;
}

/**
 * Tentukan apakah sebuah uid sudah terdaftar pada tabel `cards`.
 * @param {import('better-sqlite3').Database} db
 * @param {string} uid
 * @returns {boolean}
 */
function cardExists(db, uid) {
  const row = db.prepare('SELECT 1 FROM cards WHERE uid = ? LIMIT 1').get(uid);
  return row != null;
}

/**
 * Normalisasi satu entri log mentah dari payload firmware menjadi bentuk yang
 * aman di-ingest, dengan menjamin FK tidak dilanggar:
 *   - `device_id` di-tag dari parameter :dev; NULL bila device tidak ada.
 *   - `uid` dipertahankan bila cocok `cards.uid`; NULL bila tidak cocok/absen.
 * Field lain diteruskan apa adanya; validasi bentuk final dilakukan oleh
 * `auditTrail.recordLogs` (idempotency_key, result, ts).
 *
 * @param {object} log entri log mentah.
 * @param {string} deviceId nilai dari parameter rute :dev.
 * @param {boolean} hasDevice apakah deviceId terdaftar di `devices`.
 * @param {import('better-sqlite3').Database} db
 * @returns {object} entri ternormalisasi siap di-ingest.
 */
function normalizeLog(log, deviceId, hasDevice, db) {
  const uidRaw = log && log.uid != null ? String(log.uid) : null;
  const uid = uidRaw && cardExists(db, uidRaw) ? uidRaw : null;
  return {
    ...log,
    device_id: hasDevice ? deviceId : null,
    uid,
  };
}

/**
 * Factory Router untuk endpoint ingest offline-log.
 *
 * @param {{ db?: import('better-sqlite3').Database }} [deps]
 *   `db` instance better-sqlite3; default ke instance bersama `getDb()`.
 * @returns {import('express').Router}
 */
function createOfflineLogsRouter({ db } = {}) {
  const database = db || getDb();
  const router = express.Router();

  /**
   * POST /api/devices/:dev/offline-logs
   * Ingest batch log offline secara idempoten; balas { accepted_ids }.
   */
  router.post('/api/devices/:dev/offline-logs', (req, res) => {
    const deviceId = req.params.dev;
    const body = req.body;

    // Validasi bentuk body: wajib objek dengan array `logs`.
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.logs)) {
      res.status(400).json({
        error: 'bad_request',
        message: 'Body harus berupa objek { logs: [...] } dengan logs bertipe array',
      });
      return;
    }

    // Setiap entri harus berupa objek (bukan null/array/primitif).
    const malformed = body.logs.some(
      (log) => !log || typeof log !== 'object' || Array.isArray(log)
    );
    if (malformed) {
      res.status(400).json({
        error: 'bad_request',
        message: 'Setiap entri pada logs harus berupa objek',
      });
      return;
    }

    // Tag device_id (dari :dev) & amankan uid terhadap FK sebelum ingest.
    const hasDevice = deviceExists(database, deviceId);
    const logs = body.logs.map((log) => normalizeLog(log, deviceId, hasDevice, database));

    try {
      const { accepted_ids } = auditTrail.recordLogs(logs, SYNC_TYPE.CACHED_OFFLINE, database);
      res.status(200).json({ accepted_ids });
    } catch (err) {
      // Log tak valid (idempotency_key/result/ts hilang/salah) → 400, batch utuh
      // dibatalkan oleh transaksi auditTrail sehingga tidak ada ingest sebagian.
      if (err instanceof TypeError || err instanceof RangeError) {
        res.status(400).json({ error: 'bad_request', message: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}

module.exports = {
  createOfflineLogsRouter,
  // Diekspos untuk keperluan uji/pemakaian lanjutan.
  normalizeLog,
  deviceExists,
  cardExists,
};
