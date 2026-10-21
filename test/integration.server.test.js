'use strict';

/**
 * Integration test alur server end-to-end — Smart Door KOS ESP32 (task 19).
 *
 * Menguji aplikasi Express LENGKAP (src/app.js `createApp`) yang dijalankan pada
 * port efemeral dan digerakkan lewat `fetch`, dengan dependensi yang diinjeksi:
 *   - `db`        : SQLite in-memory terisolasi (`createDatabase(':memory:')`),
 *   - `publisher` : publisher MQTT PALSU (mock broker) yang merekam pemanggilan
 *                   `publishUnlock`/`publishRevoke`/dll — tanpa broker nyata,
 *   - `liveFeed`  : instance `LiveFeedHub` nyata (heartbeatIntervalMs:0) yang
 *                   kita suntikkan agar dapat mendaftarkan klien SSE palsu dan
 *                   meng-assert frame yang diterima.
 *
 * `SMARTDOOR_API_KEY` di-set ke kunci uji selama run dan DIPULIHKAN pada akhir
 * (afterAll) agar tidak bocor ke file test lain. Seluruh request `/api/*`
 * menyertakan header `X-API-Key`.
 *
 * Skenario (assertion nyata):
 *   1. Remote unlock via MQTT (mock broker): seed device → POST /unlock dengan
 *      API_Key valid → 200 dan publisher.publishUnlock dipanggil dengan device
 *      id + nonce (Req 12.2/12.3); request tanpa API_Key → 401.
 *   2. Live feed SSE menerima event: daftarkan klien SSE pada hub yang disuntik,
 *      lalu hub.publishAccessLog(...) → klien menerima frame `event: access`
 *      (Req 14.1).
 *   3. Ingest offline-log idempoten lintas dua pengiriman: seed device → POST
 *      /offline-logs dua kali dengan batch sama → panggilan pertama meng-ACK
 *      seluruh key unik, panggilan kedua mengembalikan accepted_ids=[] dan
 *      jumlah baris access_logs tidak bertambah (Req 6.4).
 *
 * Vitest API (describe/it/expect/beforeAll/afterAll/beforeEach) tersedia sebagai
 * global via `globals: true` (vitest.config.js) — TIDAK di-require.
 *
 * _Requirements: 12.2, 12.3, 14.1, 6.4_
 */

const http = require('http');

const { createApp } = require('../src/app.js');
const { createDatabase } = require('../src/db/index.js');
const { LiveFeedHub, EVENT_ACCESS } = require('../src/services/liveFeed.js');
const { API_KEY_ENV } = require('../src/middleware/apiKey.js');

/** API_Key uji — tidak dipakai di produksi; di-set hanya selama run ini. */
const TEST_API_KEY = 'integration-test-key-abc123';

/**
 * Jalankan sebuah Express app pada port efemeral; kembalikan base URL + close.
 * @param {import('express').Express} app
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>}
 */
function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

/** Helper POST JSON via fetch; kembalikan { status, body }. Header opsional. */
async function postJson(baseUrl, path, payload, headers = {}) {
  const resp = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  let body = null;
  const text = await resp.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: resp.status, body };
}

/**
 * Publisher MQTT PALSU (mock broker): merekam setiap pemanggilan publish.
 * Mengembalikan topik "seolah" diterbitkan agar kompatibel dengan kontrak
 * route (devices.js memakai nilai kembalian sebagai `topic`).
 */
function makeFakePublisher() {
  const calls = { publishUnlock: [], publishRevoke: [], publishConfig: [], publishOta: [] };
  return {
    calls,
    publishUnlock(deviceId, params) {
      calls.publishUnlock.push({ deviceId, params });
      return `smartdoor/${deviceId}/cmd/unlock`;
    },
    publishRevoke(deviceId, params) {
      calls.publishRevoke.push({ deviceId, params });
      return `smartdoor/${deviceId}/cmd/revoke`;
    },
    publishConfig(deviceId, params) {
      calls.publishConfig.push({ deviceId, params });
      return `smartdoor/${deviceId}/cmd/config`;
    },
    publishOta(deviceId, params) {
      calls.publishOta.push({ deviceId, params });
      return `smartdoor/${deviceId}/cmd/ota`;
    },
  };
}

/**
 * Klien SSE palsu yang merekam frame yang ditulis & menyimpan handler 'close'.
 * Cukup menyediakan write/end/on + writeHead agar diterima LiveFeedHub.
 */
function makeFakeSseClient() {
  const writes = [];
  let closeHandler = null;
  const res = {
    headers: null,
    status: null,
    ended: false,
    write(chunk) {
      writes.push(chunk);
      return true;
    },
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    end() {
      res.ended = true;
    },
    on() {},
  };
  const req = {
    on(event, handler) {
      if (event === 'close') closeHandler = handler;
    },
  };
  return { req, res, writes, triggerClose: () => closeHandler && closeHandler() };
}

/** Sisipkan satu device agar route unlock/offline-logs punya FK yang valid. */
function seedDevice(db, deviceId) {
  db.prepare('INSERT INTO devices (device_id) VALUES (?)').run(deviceId);
}

describe('integration: alur server end-to-end (task 19)', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;
  /** @type {ReturnType<typeof makeFakePublisher>} */
  let publisher;
  /** @type {LiveFeedHub} */
  let feed;
  /** @type {{ baseUrl: string, close: () => Promise<void> }} */
  let srv;
  let previousApiKey;

  beforeAll(() => {
    // Set API_Key uji; simpan nilai sebelumnya untuk dipulihkan di afterAll.
    previousApiKey = process.env[API_KEY_ENV];
    process.env[API_KEY_ENV] = TEST_API_KEY;
  });

  afterAll(() => {
    // Pulihkan/bersihkan API_Key agar tidak bocor ke file test lain.
    if (previousApiKey === undefined) {
      delete process.env[API_KEY_ENV];
    } else {
      process.env[API_KEY_ENV] = previousApiKey;
    }
  });

  beforeEach(async () => {
    db = createDatabase(':memory:');
    publisher = makeFakePublisher();
    feed = new LiveFeedHub({ heartbeatIntervalMs: 0 });
    const app = createApp({ db, publisher, liveFeed: feed });
    srv = await listen(app);
  });

  afterEach(async () => {
    if (feed) feed.close();
    if (srv) await srv.close();
    if (db && db.open) db.close();
  });

  // ---- Skenario 1: Remote unlock via MQTT (mock broker) — Req 12.2/12.3.
  describe('remote unlock via MQTT (mock broker)', () => {
    it('POST /unlock dengan API_Key valid → 200 dan publishUnlock dipanggil dengan device id + nonce', async () => {
      seedDevice(db, 'dev01');

      const res = await postJson(
        srv.baseUrl,
        '/api/devices/dev01/unlock',
        {},
        { 'x-api-key': TEST_API_KEY }
      );

      expect(res.status).toBe(200);
      expect(res.body.device_id).toBe('dev01');
      expect(typeof res.body.nonce).toBe('string');
      expect(res.body.nonce.length).toBeGreaterThan(0);
      expect(res.body.dispatched).toBe(true);

      // Publisher palsu menerima perintah dengan device id + nonce (Req 12.2/12.3).
      expect(publisher.calls.publishUnlock).toHaveLength(1);
      const call = publisher.calls.publishUnlock[0];
      expect(call.deviceId).toBe('dev01');
      expect(call.params).toMatchObject({ nonce: res.body.nonce });
      // Topik yang diterbitkan diteruskan kembali ke klien.
      expect(res.body.topic).toBe('smartdoor/dev01/cmd/unlock');
    });

    it('POST /unlock TANPA API_Key → 401 dan publisher tidak dipanggil', async () => {
      seedDevice(db, 'dev01');

      const res = await postJson(srv.baseUrl, '/api/devices/dev01/unlock', {});

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
      expect(publisher.calls.publishUnlock).toHaveLength(0);
    });
  });

  // ---- Skenario 2: Live feed SSE menerima event — Req 14.1.
  describe('live feed SSE menerima event (Req 14.1)', () => {
    it('klien SSE terdaftar pada hub menerima frame access saat publishAccessLog', () => {
      const client = makeFakeSseClient();
      feed.addClient(client.req, client.res);

      // Header SSE ter-set & koneksi mengalir (': connected').
      expect(client.res.status).toBe(200);
      expect(client.res.headers['Content-Type']).toBe('text/event-stream');
      expect(client.writes[0]).toBe(': connected\n\n');

      const accessLog = {
        device_id: 'dev01',
        uid: 'UID-AAA',
        result: 'GRANT',
        ts: '2024-01-01T00:00:00Z',
        sync_type: 'REALTIME',
      };
      const delivered = feed.publishAccessLog(accessLog);

      expect(delivered).toBe(1);
      // Frame kedua (setelah ': connected') adalah event access ter-serialisasi.
      expect(client.writes[1]).toBe(
        `event: ${EVENT_ACCESS}\ndata: ${JSON.stringify(accessLog)}\n\n`
      );
    });

    it('endpoint GET /api/feed berada di belakang API_Key (401 tanpa kunci)', async () => {
      const resp = await fetch(`${srv.baseUrl}/api/feed`);
      expect(resp.status).toBe(401);
      // Tidak perlu membaca stream; cukup pastikan gerbang API_Key menolak.
      await resp.text();
    });
  });

  // ---- Skenario 3: Ingest offline-log idempoten lintas dua pengiriman — Req 6.4.
  describe('ingest offline-log idempoten lintas dua pengiriman (Req 6.4)', () => {
    /** Hitung jumlah baris pada access_logs. */
    function logCount() {
      return db.prepare('SELECT COUNT(*) AS n FROM access_logs').get().n;
    }

    it('pengiriman pertama meng-ACK semua key unik; pengiriman identik kedua → accepted_ids=[] tanpa menambah baris', async () => {
      seedDevice(db, 'dev01');

      const batch = {
        logs: [
          { idempotency_key: 'k-1', result: 'GRANT', ts: '2024-01-01T00:00:01Z' },
          { idempotency_key: 'k-2', result: 'DENY', ts: '2024-01-01T00:00:02Z' },
          { idempotency_key: 'k-3', result: 'GRANT', ts: '2024-01-01T00:00:03Z' },
        ],
      };
      const headers = { 'x-api-key': TEST_API_KEY };

      // Pengiriman pertama: seluruh key unik diterima.
      const first = await postJson(srv.baseUrl, '/api/devices/dev01/offline-logs', batch, headers);
      expect(first.status).toBe(200);
      expect(first.body.accepted_ids.sort()).toEqual(['k-1', 'k-2', 'k-3']);
      expect(logCount()).toBe(3);

      // Pengiriman kedua IDENTIK: tidak ada yang baru → accepted_ids kosong,
      // jumlah baris tidak bertambah (idempoten, Req 6.4).
      const second = await postJson(srv.baseUrl, '/api/devices/dev01/offline-logs', batch, headers);
      expect(second.status).toBe(200);
      expect(second.body.accepted_ids).toEqual([]);
      expect(logCount()).toBe(3);
    });

    it('pengiriman kedua yang menambah satu key baru hanya meng-ACK key baru itu', async () => {
      seedDevice(db, 'dev01');
      const headers = { 'x-api-key': TEST_API_KEY };

      const batchA = {
        logs: [
          { idempotency_key: 'a-1', result: 'GRANT', ts: '2024-01-01T01:00:01Z' },
          { idempotency_key: 'a-2', result: 'DENY', ts: '2024-01-01T01:00:02Z' },
        ],
      };
      const first = await postJson(srv.baseUrl, '/api/devices/dev01/offline-logs', batchA, headers);
      expect(first.body.accepted_ids.sort()).toEqual(['a-1', 'a-2']);
      expect(logCount()).toBe(2);

      // Batch kedua memuat ulang a-2 (duplikat) + a-3 (baru).
      const batchB = {
        logs: [
          { idempotency_key: 'a-2', result: 'DENY', ts: '2024-01-01T01:00:02Z' },
          { idempotency_key: 'a-3', result: 'GRANT', ts: '2024-01-01T01:00:03Z' },
        ],
      };
      const second = await postJson(srv.baseUrl, '/api/devices/dev01/offline-logs', batchB, headers);
      expect(second.body.accepted_ids).toEqual(['a-3']);
      expect(logCount()).toBe(3);
    });
  });
});
