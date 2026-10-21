'use strict';

/**
 * Bootstrap Aplikasi — Smart Door KOS ESP32 (Web Server Node.js).
 *
 * Menyatukan seluruh potongan Web_Server menjadi satu aplikasi Express
 * (design.md "Struktur Modul (CommonJS)", baris `app.js`):
 *   - Basis data + migrasi (src/db) dijalankan saat startup.
 *   - Middleware autentikasi API_Key (src/middleware/apiKey) memproteksi SETIAP
 *     route REST `/api/*` (Req 7.3/7.4) — dipasang SEBELUM router terproteksi.
 *   - Seluruh router REST (residents, rooms, cards, provisioning, whitelist,
 *     offline-logs, devices, config, ota, revoke) di-mount sesuai konvensi path
 *     masing-masing (lihat catatan "Konvensi mounting" di bawah).
 *   - `mqttService` (src/services/mqttService) dibuat dan publisher-nya di-wire
 *     ke route yang memerlukan (devices/unlock, revoke, config, ota) serta ke
 *     billingScheduler. Koneksi broker bersifat LAZY/OPSIONAL: hanya terjadi
 *     saat `SMARTDOOR_MQTT_URL` di-set (di jalur `start()`), sehingga meng-
 *     `require('./app')` dalam pengujian TIDAK membuka socket.
 *   - `liveFeed` hub (src/services/liveFeed) menyediakan `GET /api/feed` (SSE)
 *     di belakang API_Key, dan di-wire ke mqttService agar log/alert ter-
 *     broadcast real-time ke dashboard.
 *   - `billingScheduler` (src/services/billingScheduler) memindai kartu
 *     kedaluwarsa secara periodik. Bersifat OPT-IN: hanya dimulai pada jalur
 *     `start()` (bukan saat `createApp` dipanggil uji) sehingga tidak men-spawn
 *     timer di lingkungan uji.
 *   - Dashboard statis disajikan dari `src/public/` via `express.static`.
 *
 * Konvensi mounting (penting — campuran relatif & absolut):
 *   - residents.js / rooms.js / cards.js mendefinisikan path RELATIF (`/`,
 *     `/:id`, `/:uid`) → di-mount pada prefix: `/api/residents`, `/api/rooms`,
 *     `/api/cards`.
 *   - provisioning.js / whitelist.js / offlineLogs.js / devices.js / config.js /
 *     ota.js / revoke.js mendefinisikan path PENUH `/api/...` → di-mount pada
 *     root app (`app.use(router)`).
 *
 * Desain dapat-diuji (injectable):
 *   - `createApp({ db, publisher, liveFeed } = {})` mengembalikan instance
 *     Express TANPA `listen()` (tidak membuka socket). `db`/`publisher`/
 *     `liveFeed` dapat diinjeksi untuk uji (mis. DB in-memory + publisher palsu).
 *   - `start(port)` membangun app dengan dependensi nyata, menghubungkan MQTT
 *     secara lazy bila dikonfigurasi, memulai billingScheduler, lalu
 *     mendengarkan pada `port`.
 *   - `listen()` di-guard `if (require.main === module)` sehingga `require`-ing
 *     modul ini tidak pernah menjalankan server.
 *
 * _Requirements: 7.2, 7.3, 7.4, 8.1, 8.2, 9.2, 10.1, 11.1, 12.2, 14.1, 16.2, 17.3_
 */

const path = require('path');
const express = require('express');

const { getDb } = require('./db');
const { apiKeyMiddleware } = require('./middleware/apiKey');

// Routers dengan path RELATIF (di-mount pada prefix).
const createResidentsRouter = require('./routes/residents');
const createRoomsRouter = require('./routes/rooms');
const createCardsRouter = require('./routes/cards');

// Routers dengan path PENUH `/api/...` (di-mount pada root app).
const { createProvisioningRouter } = require('./routes/provisioning');
const { createWhitelistRouter } = require('./routes/whitelist');
const { createOfflineLogsRouter } = require('./routes/offlineLogs');
const { createDevicesRouter } = require('./routes/devices');
const { createConfigRouter } = require('./routes/config');
const { createOtaRouter } = require('./routes/ota');
const { createRevokeRouter } = require('./routes/revoke');

// Services.
const { createMqttService } = require('./services/mqttService');
const liveFeedModule = require('./services/liveFeed');
const billingScheduler = require('./services/billingScheduler');

/** Direktori dashboard statis: src/public (design.md `public/`). */
const PUBLIC_DIR = path.join(__dirname, 'public');

/** Nama variabel environment URL broker MQTT (connect lazy bila di-set). */
const MQTT_URL_ENV = 'SMARTDOOR_MQTT_URL';

/** Port default server bila tidak diberikan argumen/env. */
const DEFAULT_PORT = Number(process.env.PORT) || 3000;

/**
 * Bangun instance aplikasi Express lengkap TANPA mendengarkan port.
 *
 * Seluruh router REST `/api/*` berada DI BELAKANG middleware API_Key. Dashboard
 * statis (`/`) dan aset publik disajikan TANPA API_Key karena bukan jalur data
 * REST; setiap jalur data `/api` tetap wajib API_Key valid (design.md
 * "Autentikasi API_Key").
 *
 * @param {object} [deps]
 * @param {import('better-sqlite3').Database} [deps.db] instance DB (default
 *   instance bersama `getDb()`). Untuk uji, injeksikan `createDatabase(':memory:')`.
 * @param {object} [deps.publisher] publisher MQTT (mis. instance mqttService)
 *   dengan method `publishUnlock`/`publishRevoke`/`publishConfig`/`publishOta`.
 *   Bila absen, route tetap berfungsi namun aksi yang butuh publish akan
 *   melaporkan kegagalan sinkronisasi/dispatch sesuai kontrak route.
 * @param {object} [deps.liveFeed] hub live feed (default singleton
 *   `liveFeed.hub`). Menyediakan `handler()` untuk `GET /api/feed`.
 * @returns {import('express').Express} aplikasi Express siap pakai.
 */
function createApp({ db, publisher, liveFeed } = {}) {
  const database = db || getDb();
  const feed = liveFeed || liveFeedModule.hub;
  const pub = publisher || null;

  const app = express();

  // Parsing body JSON untuk seluruh route. express.json() HANYA mem-parse
  // `application/json`, sehingga TIDAK mengganggu unggahan OTA yang memakai
  // `application/octet-stream` (ota.js memasang express.raw() sendiri).
  app.use(express.json());

  // Dashboard statis (TANPA API_Key) — bukan jalur data REST.
  app.use(express.static(PUBLIC_DIR));

  // ---- Gerbang API_Key: SEMUA route /api/* harus menyertakan API_Key valid.
  // Dipasang SEBELUM router terproteksi (Req 7.3/7.4). Static di atas tidak
  // berada di bawah /api sehingga tidak terpengaruh.
  app.use('/api', apiKeyMiddleware);

  // ---- Live feed SSE (di belakang API_Key via gerbang di atas) — Req 14.1.
  app.get('/api/feed', feed.handler());

  // ---- Router path RELATIF → di-mount pada prefix.
  app.use('/api/residents', createResidentsRouter({ db: database })); // Req 8.1
  app.use('/api/rooms', createRoomsRouter({ db: database })); // Req 8.2
  app.use('/api/cards', createCardsRouter({ db: database })); // Req 8.3

  // ---- Router path PENUH `/api/...` → di-mount pada root app.
  app.use(createProvisioningRouter({ db: database })); // POST /api/provisioning (Req 2)
  app.use(createWhitelistRouter({ db: database })); // GET  /api/devices/:dev/whitelist (Req 4.3/7.2)
  app.use(createOfflineLogsRouter({ db: database })); // POST /api/devices/:dev/offline-logs (Req 6.4)
  app.use(createDevicesRouter({ db: database, publisher: pub })); // device health + unlock (Req 11/12)
  app.use(createConfigRouter({ db: database, publisher: pub })); // PUT  /api/devices/:dev/config (Req 17.3)
  app.use(createOtaRouter({ db: database, publisher: pub })); // POST /api/devices/:dev/ota (Req 16.2)
  app.use(createRevokeRouter({ db: database, publisher: pub })); // POST /api/cards/:uid/revoke (Req 10.1)

  return app;
}

/**
 * Bangun aplikasi dengan dependensi NYATA, hubungkan MQTT secara lazy bila
 * dikonfigurasi, mulai billing-lock scheduler, lalu dengarkan pada `port`.
 *
 * - MQTT: service selalu dibuat (agar publisher tersedia bagi route), namun
 *   `connect()` HANYA dipanggil bila `SMARTDOOR_MQTT_URL` di-set — sehingga
 *   lingkungan tanpa broker tetap bisa menjalankan server tanpa membuka socket.
 *   Saat tersambung, hub live feed di-wire agar log/alert ter-broadcast.
 * - billingScheduler: dimulai di sini (jalur runtime), bukan di `createApp`,
 *   agar uji yang memanggil `createApp` tidak men-spawn timer.
 *
 * @param {number} [port] port untuk didengarkan (default `PORT` env / 3000).
 * @returns {{ app: import('express').Express, server: import('http').Server, mqtt: object }}
 */
function start(port = DEFAULT_PORT) {
  const database = getDb();
  const feed = liveFeedModule.hub;

  // Buat service MQTT dan wire hub live feed agar log/alert ter-broadcast.
  const mqtt = createMqttService({ db: database, liveFeed: feed });

  // Koneksi broker bersifat lazy/opsional: hanya bila URL dikonfigurasi.
  const brokerUrl = process.env[MQTT_URL_ENV];
  if (brokerUrl) {
    try {
      mqtt.connect(brokerUrl);
    } catch (err) {
      // Koneksi broker gagal tidak boleh mematikan server REST/dashboard.
      // eslint-disable-next-line no-console
      console.error(`app: gagal menghubungkan MQTT (${brokerUrl}):`, err.message);
    }
  }

  // App memakai publisher mqttService sehingga route unlock/revoke/config/ota
  // dapat mem-publish perintah ke firmware.
  const app = createApp({ db: database, publisher: mqtt, liveFeed: feed });

  // Mulai billing-lock scheduler periodik (Req 9) dengan publisher MQTT.
  billingScheduler.start({ db: database, publisher: mqtt });

  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Smart Door KOS server mendengarkan pada port ${port}`);
  });

  return { app, server, mqtt };
}

module.exports = {
  createApp,
  start,
  PUBLIC_DIR,
  MQTT_URL_ENV,
  DEFAULT_PORT,
};

// Jalankan server HANYA bila modul ini dieksekusi langsung (`node src/app.js`),
// bukan saat di-`require` (mis. oleh uji) — guard agar tidak membuka socket.
if (require.main === module) {
  start();
}
