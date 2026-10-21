'use strict';

/**
 * Unit test binding & provisioning — Smart Door KOS ESP32 (task 15.3).
 *
 * Menguji dua router Express terhadap instance SQLite in-memory terisolasi
 * (createDatabase(':memory:')), lewat aplikasi Express nyata pada port efemeral
 * yang digerakkan dengan `fetch` — tanpa supertest (tidak terpasang) — agar
 * assertion benar-benar melewati pipeline HTTP + handler + DB.
 *
 * Cakupan:
 *   - Binding kartu (cards.js, Req 8.3/8.4): create uid→user_id→room_id sukses;
 *     kartu kedua yang memakai ulang user_id / room_id / uid ditolak 409
 *     (binding ketat satu-ke-satu, tanpa rebinding otomatis).
 *   - Provisioning sukses (provisioning.js, Req 2.3): cardWriter stub sukses +
 *     SMARTDOOR_MASTER_KEY di-set → 201, baris kartu ACTIVE dengan key_version.
 *   - Provisioning gagal (Req 2.3): cardWriter melempar / mengembalikan
 *     { ok:false } → respons kode error (4xx/5xx) dan baris kartu UNPROVISIONED.
 *
 * Vitest API (describe/it/expect/beforeEach/afterEach) tersedia sebagai global
 * via `globals: true` (vitest.config.js) — tidak di-require.
 *
 * _Requirements: 8.3, 2.3_
 */

const http = require('http');
const express = require('express');

const { createDatabase } = require('../src/db/index.js');
const createCardsRouter = require('../src/routes/cards.js');
const { createProvisioningRouter } = require('../src/routes/provisioning.js');
const { MASTER_KEY_ENV } = require('../src/services/keyDerivation.js');

/** Master_Key uji: 32 hex char = 16 byte (AES-128). TIDAK dipakai di produksi. */
const TEST_MASTER_KEY = '00112233445566778899aabbccddeeff';

/**
 * Jalankan sebuah Express app pada port efemeral dan kembalikan base URL +
 * fungsi close. Memakai http.Server agar mudah di-teardown per-test.
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

/** Helper POST JSON via fetch; kembalikan { status, body }. */
async function postJson(baseUrl, path, payload) {
  const resp = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
 * Sisipkan prasyarat (users, rooms, devices) agar FK cards terpenuhi.
 * @param {import('better-sqlite3').Database} db
 */
function seedPrerequisites(db) {
  db.prepare('INSERT INTO devices (device_id) VALUES (?)').run('dev01');
  const roomA = db
    .prepare('INSERT INTO rooms (room_no, device_id) VALUES (?, ?)')
    .run('A-101', 'dev01');
  const roomB = db.prepare('INSERT INTO rooms (room_no) VALUES (?)').run('A-102');
  const userA = db.prepare('INSERT INTO users (name) VALUES (?)').run('Budi');
  const userB = db.prepare('INSERT INTO users (name) VALUES (?)').run('Siti');
  return {
    roomAId: Number(roomA.lastInsertRowid),
    roomBId: Number(roomB.lastInsertRowid),
    userAId: Number(userA.lastInsertRowid),
    userBId: Number(userB.lastInsertRowid),
  };
}

describe('binding kartu — cards.js (Req 8.3/8.4)', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;
  /** @type {{ baseUrl: string, close: () => Promise<void> }} */
  let srv;
  let ids;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    ids = seedPrerequisites(db);
    const app = express();
    app.use(express.json());
    app.use('/api/cards', createCardsRouter({ db }));
    srv = await listen(app);
  });

  afterEach(async () => {
    if (srv) await srv.close();
    if (db && db.open) db.close();
  });

  it('membuat binding uid→user_id→room_id dengan sukses (201)', async () => {
    const res = await postJson(srv.baseUrl, '/api/cards', {
      uid: 'UID-AAA',
      user_id: ids.userAId,
      room_id: ids.roomAId,
      status: 'ACTIVE',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      uid: 'UID-AAA',
      user_id: ids.userAId,
      room_id: ids.roomAId,
      status: 'ACTIVE',
    });

    const row = db.prepare('SELECT * FROM cards WHERE uid = ?').get('UID-AAA');
    expect(row.user_id).toBe(ids.userAId);
    expect(row.room_id).toBe(ids.roomAId);
  });

  it('menolak kartu kedua yang memakai ulang user_id yang sama (409)', async () => {
    await postJson(srv.baseUrl, '/api/cards', {
      uid: 'UID-AAA',
      user_id: ids.userAId,
      room_id: ids.roomAId,
    });

    const res = await postJson(srv.baseUrl, '/api/cards', {
      uid: 'UID-BBB',
      user_id: ids.userAId, // reuse user_id
      room_id: ids.roomBId,
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict');
    // Binding ketat: kartu kedua tidak tercipta.
    expect(db.prepare('SELECT COUNT(*) AS n FROM cards').get().n).toBe(1);
  });

  it('menolak kartu kedua yang memakai ulang room_id yang sama (409)', async () => {
    await postJson(srv.baseUrl, '/api/cards', {
      uid: 'UID-AAA',
      user_id: ids.userAId,
      room_id: ids.roomAId,
    });

    const res = await postJson(srv.baseUrl, '/api/cards', {
      uid: 'UID-BBB',
      user_id: ids.userBId,
      room_id: ids.roomAId, // reuse room_id
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict');
    expect(db.prepare('SELECT COUNT(*) AS n FROM cards').get().n).toBe(1);
  });

  it('menolak kartu kedua yang memakai ulang uid yang sama (409, tanpa rebinding)', async () => {
    await postJson(srv.baseUrl, '/api/cards', {
      uid: 'UID-AAA',
      user_id: ids.userAId,
      room_id: ids.roomAId,
    });

    const res = await postJson(srv.baseUrl, '/api/cards', {
      uid: 'UID-AAA', // reuse uid
      user_id: ids.userBId,
      room_id: ids.roomBId,
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict');
    // Binding awal tidak berubah (tanpa rebinding otomatis).
    const row = db.prepare('SELECT * FROM cards WHERE uid = ?').get('UID-AAA');
    expect(row.user_id).toBe(ids.userAId);
    expect(row.room_id).toBe(ids.roomAId);
  });

  it('mengizinkan dua kartu dengan binding user & room berbeda', async () => {
    const first = await postJson(srv.baseUrl, '/api/cards', {
      uid: 'UID-AAA',
      user_id: ids.userAId,
      room_id: ids.roomAId,
    });
    const second = await postJson(srv.baseUrl, '/api/cards', {
      uid: 'UID-BBB',
      user_id: ids.userBId,
      room_id: ids.roomBId,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cards').get().n).toBe(2);
  });
});

describe('provisioning — provisioning.js (Req 2.3)', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;
  /** @type {{ baseUrl: string, close: () => Promise<void> }} */
  let srv;
  let ids;
  let previousMasterKey;

  beforeEach(() => {
    // Set Master_Key uji (32 hex char). Simpan nilai sebelumnya untuk restore.
    previousMasterKey = process.env[MASTER_KEY_ENV];
    process.env[MASTER_KEY_ENV] = TEST_MASTER_KEY;

    db = createDatabase(':memory:');
    ids = seedPrerequisites(db);
  });

  afterEach(async () => {
    if (srv) await srv.close();
    if (db && db.open) db.close();
    // Restore/clear Master_Key agar tidak bocor ke test lain.
    if (previousMasterKey === undefined) {
      delete process.env[MASTER_KEY_ENV];
    } else {
      process.env[MASTER_KEY_ENV] = previousMasterKey;
    }
  });

  /** Bangun app provisioning dengan cardWriter yang disuntik. */
  async function startApp(cardWriter) {
    const app = express();
    app.use(express.json());
    app.use('/', createProvisioningRouter({ db, cardWriter }));
    srv = await listen(app);
  }

  it('sukses: writer OK + Master_Key → 201 dan kartu ACTIVE dengan key_version', async () => {
    const writer = {
      write() {
        return { ok: true };
      },
    };
    await startApp(writer);

    const res = await postJson(srv.baseUrl, '/api/provisioning', {
      uid: 'UID-PROV-OK',
      resident_id: ids.userAId,
      room_id: ids.roomAId,
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.key_version).toBeGreaterThanOrEqual(1);

    const row = db.prepare('SELECT * FROM cards WHERE uid = ?').get('UID-PROV-OK');
    expect(row).toBeTruthy();
    expect(row.status).toBe('ACTIVE');
    expect(row.key_version).toBeGreaterThanOrEqual(1);
    expect(row.user_id).toBe(ids.userAId);
    expect(row.room_id).toBe(ids.roomAId);
  });

  it('gagal (writer melempar): respons 5xx dan kartu UNPROVISIONED', async () => {
    const writer = {
      write() {
        throw new Error('NFC writer offline');
      },
    };
    await startApp(writer);

    const res = await postJson(srv.baseUrl, '/api/provisioning', {
      uid: 'UID-PROV-THROW',
      resident_id: ids.userAId,
      room_id: ids.roomAId,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);
    expect(res.body.error).toBeTruthy();

    const row = db.prepare('SELECT * FROM cards WHERE uid = ?').get('UID-PROV-THROW');
    expect(row).toBeTruthy();
    expect(row.status).toBe('UNPROVISIONED');
  });

  it('gagal (writer mengembalikan { ok:false }): respons error dan kartu UNPROVISIONED', async () => {
    const writer = {
      write() {
        return { ok: false, message: 'write verify mismatch' };
      },
    };
    await startApp(writer);

    const res = await postJson(srv.baseUrl, '/api/provisioning', {
      uid: 'UID-PROV-FALSE',
      resident_id: ids.userAId,
      room_id: ids.roomAId,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);
    expect(res.body.error).toBe('card_write_failed');

    const row = db.prepare('SELECT * FROM cards WHERE uid = ?').get('UID-PROV-FALSE');
    expect(row).toBeTruthy();
    expect(row.status).toBe('UNPROVISIONED');
  });
});
