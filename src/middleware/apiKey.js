'use strict';

/**
 * Autentikasi API_Key — Smart Door KOS ESP32 (Web Server Node.js).
 *
 * Mengimplementasikan "Autentikasi API_Key (Req 7)" dari design.md:
 *   - Middleware `apiKeyMiddleware` memeriksa header `X-API-Key` (atau field
 *     `api_key` pada payload JSON) pada SETIAP request REST; menolak dengan
 *     `401 Unauthorized` bila absen/salah (Req 7.4).
 *   - Helper `isValidApiKey(provided)` dipakai ulang oleh konsumer MQTT untuk
 *     memvalidasi `api_key` di dalam setiap payload sebelum memproses (Req 7.3);
 *     perintah tanpa API_Key valid diabaikan.
 *
 * API_Key TIDAK PERNAH di-hardcode — dibaca dari environment
 * (`SMARTDOOR_API_KEY`). Perbandingan dilakukan konstan-waktu
 * (`crypto.timingSafeEqual` dengan penjaga panjang) untuk mengurangi timing
 * attack.
 *
 * Secure-by-default: bila API_Key belum dikonfigurasi di environment, SEMUA
 * permintaan ditolak (fail-closed). Server tidak boleh berjalan tanpa autentikasi.
 *
 * _Requirements: 7.3, 7.4_
 */

const crypto = require('crypto');
const { API_KEY_HEADER } = require('../constants');

/** Nama variabel environment yang menyimpan API_Key. */
const API_KEY_ENV = 'SMARTDOOR_API_KEY';

/**
 * Baca API_Key terkonfigurasi dari environment (`SMARTDOOR_API_KEY`).
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string} nilai API_Key, atau string kosong bila tidak di-set.
 */
function loadConfiguredApiKey(env = process.env) {
  const raw = env[API_KEY_ENV];
  return typeof raw === 'string' ? raw : '';
}

/**
 * Perbandingan dua string secara konstan-waktu.
 * Mengembalikan `false` lebih dulu bila panjang byte berbeda (penjaga panjang),
 * karena `crypto.timingSafeEqual` mensyaratkan buffer berukuran sama.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validasi API_Key yang diberikan terhadap nilai terkonfigurasi.
 *
 * Fungsi murni: tidak ada efek samping. Dipakai oleh middleware REST maupun
 * konsumer MQTT (validasi per-payload). Menggunakan perbandingan konstan-waktu.
 *
 * Aturan:
 *   - `false` bila `provided` kosong/null/undefined/non-string.
 *   - `false` bila API_Key belum dikonfigurasi (secure-by-default: tolak semua).
 *   - `true` hanya bila `provided` sama persis dengan API_Key terkonfigurasi.
 *
 * @param {string} provided  API_Key yang disertakan pemanggil.
 * @param {NodeJS.ProcessEnv} [env=process.env]  sumber konfigurasi (untuk uji).
 * @returns {boolean} `true` iff API_Key valid.
 */
function isValidApiKey(provided, env = process.env) {
  if (typeof provided !== 'string' || provided.length === 0) {
    return false;
  }
  const configured = loadConfiguredApiKey(env);
  // Secure-by-default: tanpa konfigurasi, tolak semua permintaan (fail-closed).
  if (!configured) {
    return false;
  }
  return timingSafeEqualStr(provided, configured);
}

/**
 * Ambil API_Key dari sebuah request Express.
 * Prioritas: header `X-API-Key` (case-insensitive via Express `req.headers`),
 * kemudian field `api_key` pada body JSON bila ada.
 * @param {import('express').Request} req
 * @returns {string|undefined} API_Key yang ditemukan, atau undefined.
 */
function extractApiKey(req) {
  // Header dinormalisasi lowercase oleh Node/Express, cocok dengan API_KEY_HEADER.
  const headers = (req && req.headers) || {};
  const headerVal = headers[API_KEY_HEADER];
  if (typeof headerVal === 'string' && headerVal.length > 0) {
    return headerVal;
  }
  const body = (req && req.body) || {};
  if (body && typeof body.api_key === 'string' && body.api_key.length > 0) {
    return body.api_key;
  }
  return undefined;
}

/**
 * Middleware Express autentikasi API_Key.
 *
 * Membaca API_Key dari header `X-API-Key` (case-insensitive) atau field
 * `api_key` pada body JSON, lalu memvalidasi via `isValidApiKey`. Bila absen
 * atau tidak valid, merespons `401 Unauthorized` dengan body JSON error dan
 * TIDAK memanggil `next()`. Bila valid, meneruskan ke handler berikutnya.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function apiKeyMiddleware(req, res, next) {
  const provided = extractApiKey(req);
  if (!isValidApiKey(provided)) {
    res.status(401).json({
      error: 'unauthorized',
      message: 'API_Key absen atau tidak valid',
    });
    return;
  }
  next();
}

module.exports = {
  API_KEY_ENV,
  isValidApiKey,
  apiKeyMiddleware,
  // Diekspos untuk pemakaian ulang/uji; bukan bagian kontrak utama.
  loadConfiguredApiKey,
  extractApiKey,
};
