'use strict';

/**
 * Web OTA Update — route REST (Smart Door KOS ESP32, Web Server Node.js).
 *
 * Mengimplementasikan design.md "Web OTA Update (Req 16)":
 *
 *   Dashboard --(.bin upload)--> ota.js : simpan berkas + checksum (SHA-256)
 *   ota.js    --(MQTT cmd/ota)-> Firmware: { url unduh, checksum, api_key }
 *   Firmware  --(HTTP GET url)-> ota.js : tarik `.bin` dengan API_Key
 *   Firmware                            : verifikasi checksum/validitas lalu apply
 *
 * Tanggung jawab (task 17.2, Req 16.1/16.2/16.3):
 *   - `POST /api/devices/:dev/ota`:
 *       1. 404 bila device `:dev` tidak terdaftar pada `devices`.
 *       2. Terima unggahan `.bin` sebagai body mentah
 *          `application/octet-stream` (Buffer). Pilihan transport: RAW octet-
 *          stream (paling sederhana; tidak perlu dekode base64). Konfigurasi
 *          via `express.raw` di dalam router sehingga tidak bergantung pada
 *          body-parser global.
 *       3. 400 bila unggahan KOSONG/korup, atau bila klien menyertakan
 *          `expected_checksum` (query/header `x-expected-checksum`) yang TIDAK
 *          cocok dengan SHA-256 berkas (verifyBinary === false). Berkas korup
 *          ditolak dan TIDAK disimpan (Req 16.3).
 *       4. Hitung SHA-256, simpan `.bin` ke `storageDir` (default dir OTA temp),
 *          catat firmware + checksum (registry in-memory per-device), lalu
 *          publish notifikasi OTA-tersedia ke device via publisher ter-inject
 *          (URL unduh + api_key disisipkan oleh publisher), Req 16.2.
 *       5. Respons 200 { device_id, checksum, size, url, filename }.
 *
 * Verifikasi akhir ada di FIRMWARE (Req 16.3/16.4): server hanya menyimpan,
 * memvalidasi unggahan, dan memberi tahu. Firmware menarik `.bin`, memverifikasi
 * checksum/validitas, dan HANYA menerapkan bila lolos; bila gagal ia membatalkan
 * dan tetap menjalankan firmware lama. Saat swap firmware valid, kunci MAY
 * sejenak tidak beroperasi hingga firmware baru siap (Req 16.4).
 *
 * Helper murni `verifyBinary(bytes, expectedChecksum)` adalah REFERENSI PORTABEL
 * untuk keputusan apply/tolak (Property 16): mengembalikan true iff
 * SHA-256(bytes) hex === expectedChecksum (perbandingan case-insensitive).
 * Fungsi ini bebas efek samping sehingga dapat diuji unit/property.
 *
 * Desain dapat-diuji (injectable): factory
 * `createOtaRouter({ db, publisher, storageDir })` menerima `db` (default
 * getDb()), `publisher` (mis. instance mqttService dengan `publishOta`), dan
 * `storageDir` (default <workspace>/data/ota). Router ini TIDAK memasang
 * middleware apiKey sendiri; proteksi dipasang saat mounting (task 18).
 *
 * _Requirements: 16.1, 16.2, 16.3_
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const { getDb } = require('../db');

/** Direktori penyimpanan `.bin` OTA default: <workspace>/data/ota. */
const DEFAULT_STORAGE_DIR = path.join(__dirname, '..', '..', 'data', 'ota');

/** Batas ukuran unggahan `.bin` (bytes). ESP32 flash app ~ beberapa MB. */
const MAX_BIN_BYTES = 16 * 1024 * 1024; // 16 MiB

/**
 * Hitung digest SHA-256 (hex lowercase) dari sebuah Buffer.
 * @param {Buffer} bytes isi biner.
 * @returns {string} hex digest 64 karakter.
 */
function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Helper MURNI referensi verifikasi firmware (Property 16, Req 16.3).
 *
 * Mengembalikan true JIKA DAN HANYA JIKA SHA-256(bytes) hex === expectedChecksum
 * (perbandingan hex case-insensitive). Mengembalikan false bila input hilang/
 * tidak valid (bytes bukan Buffer/Uint8Array, kosong, atau checksum bukan string
 * hex), maupun bila digest tidak cocok. Tidak melempar dan tidak punya efek
 * samping — aman dipakai sebagai referensi portabel keputusan apply/tolak di
 * firmware maupun pada unit/property test.
 *
 * @param {Buffer|Uint8Array} bytes isi biner firmware.
 * @param {string} expectedChecksum checksum SHA-256 heksadesimal yang diharapkan.
 * @returns {boolean} true iff digest cocok; selain itu false.
 */
function verifyBinary(bytes, expectedChecksum) {
  // Input wajib: isi biner non-kosong + checksum string.
  if (bytes == null || typeof expectedChecksum !== 'string') {
    return false;
  }

  let buf;
  if (Buffer.isBuffer(bytes)) {
    buf = bytes;
  } else if (bytes instanceof Uint8Array) {
    buf = Buffer.from(bytes);
  } else {
    return false;
  }
  if (buf.length === 0) {
    return false;
  }

  // Normalisasi checksum: trim + lowercase, wajib hex SHA-256 (64 digit).
  const expected = expectedChecksum.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return false;
  }

  const actual = sha256Hex(buf);
  // Perbandingan konstan-waktu atas dua string hex berpanjang sama.
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/** SQL cek keberadaan device. */
const SELECT_DEVICE_EXISTS_SQL =
  'SELECT 1 AS present FROM devices WHERE device_id = @device_id LIMIT 1';

/**
 * Apakah device terdaftar pada basis data.
 * @param {import('better-sqlite3').Database} db
 * @param {string} deviceId
 * @returns {boolean}
 */
function deviceExists(db, deviceId) {
  return Boolean(db.prepare(SELECT_DEVICE_EXISTS_SQL).get({ device_id: deviceId }));
}

/**
 * Nama berkas `.bin` deterministik & aman untuk sebuah device+checksum.
 * Menyertakan checksum agar berkas identik tidak ditulis ulang dan tabrakan
 * antar device dihindari. device_id disanitasi ke [A-Za-z0-9_-].
 * @param {string} deviceId
 * @param {string} checksum SHA-256 hex.
 * @returns {string} nama berkas, mis. `dev01-<checksum>.bin`.
 */
function binFilename(deviceId, checksum) {
  const safeDev = String(deviceId).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${safeDev}-${checksum}.bin`;
}

/**
 * Pastikan direktori penyimpanan ada (buat rekursif bila belum).
 * @param {string} dir
 */
function ensureStorageDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Publish notifikasi OTA-tersedia ke firmware device via publisher ter-inject.
 *
 * Mendukung beberapa bentuk publisher agar fleksibel & mudah diuji (selaras
 * pola publishRevoke di revoke.js):
 *   - `publisher.publishOta(deviceId, { url, checksum })` (disarankan, mqttService)
 *   - `publisher.publishCommand(deviceId, 'cmd/ota', { url, checksum })`
 *   - `publisher.publish(topic, payload)` (fallback generik)
 *
 * @param {{publishOta?:Function, publishCommand?:Function, publish?:Function}} publisher
 * @param {string} deviceId
 * @param {{ url: string, checksum: string }} payload
 */
function publishOta(publisher, deviceId, payload) {
  if (publisher && typeof publisher.publishOta === 'function') {
    publisher.publishOta(deviceId, payload);
    return;
  }
  if (publisher && typeof publisher.publishCommand === 'function') {
    publisher.publishCommand(deviceId, 'cmd/ota', payload);
    return;
  }
  if (publisher && typeof publisher.publish === 'function') {
    publisher.publish(`smartdoor/${deviceId}/cmd/ota`, payload);
    return;
  }
  throw new TypeError(
    'publishOta: publisher harus menyediakan publishOta(deviceId, { url, checksum }), publishCommand, atau publish'
  );
}

/**
 * Factory Router Express untuk Web OTA Update.
 *
 * @param {object} [deps]
 * @param {import('better-sqlite3').Database} [deps.db] instance DB (default getDb()).
 * @param {object} [deps.publisher] publisher MQTT (mis. mqttService) dengan
 *   `publishOta(deviceId, { url, checksum })`. Opsional: bila absen, notifikasi
 *   dilewati (berkas tetap tersimpan & tercatat).
 * @param {string} [deps.storageDir] direktori penyimpanan `.bin` (default data/ota).
 * @returns {import('express').Router}
 */
function createOtaRouter(deps = {}) {
  const { db = getDb(), publisher = null, storageDir = DEFAULT_STORAGE_DIR } = deps;

  const router = express.Router();

  // Registry firmware terakhir per device (server-side record). In-memory:
  // skema DB tidak menyertakan tabel firmware, dan source-of-truth verifikasi
  // ada di firmware (Req 16.3). Registry membantu endpoint unduh menyajikan
  // berkas yang benar.
  const latestByDevice = new Map();

  // Parser body mentah khusus octet-stream untuk endpoint upload ini.
  const rawBin = express.raw({
    type: ['application/octet-stream', 'application/macbinary'],
    limit: MAX_BIN_BYTES,
  });

  /**
   * POST /api/devices/:dev/ota
   * Unggah `.bin`, validasi, simpan, catat, dan jadwalkan delivery OTA.
   */
  router.post('/api/devices/:dev/ota', rawBin, (req, res) => {
    const deviceId = req.params.dev;

    // 1) 404 bila device tidak terdaftar.
    if (!deviceExists(db, deviceId)) {
      res.status(404).json({
        error: 'device_not_found',
        message: `Device "${deviceId}" tidak ditemukan`,
      });
      return;
    }

    // 2) Ambil Buffer unggahan dari body mentah.
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;

    // 3) 400 bila unggahan kosong/korup (tak ada isi biner).
    if (!bytes || bytes.length === 0) {
      res.status(400).json({
        error: 'empty_upload',
        message: 'Unggahan .bin kosong atau tidak valid (gunakan application/octet-stream)',
      });
      return;
    }

    const checksum = sha256Hex(bytes);

    // 4) Bila klien menyertakan expected checksum, tolak 400 saat tidak cocok
    //    (verifyBinary false → korup/salah; Req 16.3). Sumber: header atau query.
    const expected =
      (req.get('x-expected-checksum') || req.query.expected_checksum || '').toString().trim();
    if (expected && !verifyBinary(bytes, expected)) {
      res.status(400).json({
        error: 'checksum_mismatch',
        message: 'Checksum berkas tidak cocok dengan expected_checksum; unggahan ditolak',
        expected: expected.toLowerCase(),
        actual: checksum,
      });
      return;
    }

    // 5) Simpan berkas ke storageDir (nama deterministik dev+checksum).
    ensureStorageDir(storageDir);
    const filename = binFilename(deviceId, checksum);
    const filePath = path.join(storageDir, filename);
    try {
      fs.writeFileSync(filePath, bytes);
    } catch (err) {
      res.status(500).json({
        error: 'storage_failed',
        message: `Gagal menyimpan berkas OTA: ${err.message}`,
      });
      return;
    }

    // URL unduh yang akan ditarik firmware (API_Key disertakan saat GET).
    const url = `/api/devices/${encodeURIComponent(deviceId)}/ota/${encodeURIComponent(filename)}`;

    // Catat firmware + checksum (server-side record).
    latestByDevice.set(deviceId, {
      filename,
      checksum,
      size: bytes.length,
      path: filePath,
      url,
      uploaded_at: new Date().toISOString(),
    });

    // 6) Jadwalkan delivery OTA: publish notifikasi via publisher ter-inject.
    //    Kegagalan publish TIDAK membatalkan penyimpanan (berkas tetap siap
    //    ditarik firmware); dilaporkan lewat field `scheduled`.
    let scheduled = false;
    if (publisher) {
      try {
        publishOta(publisher, deviceId, { url, checksum });
        scheduled = true;
      } catch {
        scheduled = false;
      }
    }

    res.status(200).json({
      device_id: deviceId,
      checksum,
      size: bytes.length,
      filename,
      url,
      scheduled,
    });
  });

  /**
   * GET /api/devices/:dev/ota/:filename
   * Firmware menarik `.bin` tersimpan (API_Key diproteksi saat mounting).
   * 404 bila device/berkas tidak ada.
   */
  router.get('/api/devices/:dev/ota/:filename', (req, res) => {
    const deviceId = req.params.dev;
    if (!deviceExists(db, deviceId)) {
      res.status(404).json({ error: 'device_not_found' });
      return;
    }
    // Cegah path traversal: hanya izinkan nama berkas dasar.
    const filename = path.basename(req.params.filename);
    const filePath = path.join(storageDir, filename);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'firmware_not_found' });
      return;
    }
    res.type('application/octet-stream');
    res.sendFile(filePath);
  });

  // Ekspos registry untuk pemakaian lanjutan/uji (tanpa mengubah kontrak).
  router.getLatest = (deviceId) => latestByDevice.get(deviceId) || null;

  return router;
}

module.exports = {
  createOtaRouter,
  // Helper MURNI referensi verifikasi firmware (Property 16, Req 16.3).
  verifyBinary,
  // Diekspos untuk pemakaian ulang/uji.
  sha256Hex,
  binFilename,
  deviceExists,
  publishOta,
  DEFAULT_STORAGE_DIR,
  MAX_BIN_BYTES,
};
