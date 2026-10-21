'use strict';

/**
 * Unit test constraint skema basis data — Smart Door KOS ESP32 (task 2.3).
 *
 * Memverifikasi constraint integritas pada src/db/schema.sql menggunakan
 * instance SQLite in-memory terisolasi dari factory createDatabase(':memory:').
 *
 * Cakupan:
 *   - UNIQUE(uid) / PRIMARY KEY pada cards menolak kartu ganda (Req 8.3).
 *   - UNIQUE(idempotency_key) pada access_logs menolak kunci idempoten ganda
 *     (Req 19.3) — fondasi ingest offline-log idempoten.
 *   - Binding ketat satu-ke-satu: UNIQUE(user_id) & UNIQUE(room_id) pada cards
 *     mencegah rebinding ke user/room yang sama (Req 8.4).
 *   - Insert valid yang berbeda tetap berhasil.
 *   - CHECK constraint menolak nilai status / sync_type / result yang invalid.
 *
 * _Requirements: 8.3, 8.4, 19.3_
 */

// Vitest API (describe/it/expect/beforeEach/afterEach) tersedia sebagai global
// via konfigurasi `globals: true` (lihat vitest.config.js) — tidak di-require
// karena Vitest tidak dapat diimpor melalui require() pada modul CommonJS.
const { createDatabase } = require('../src/db/index.js');

/** @type {import('better-sqlite3').Database & { tx: Function }} */
let db;

/**
 * Sisipkan baris prasyarat (users, rooms, devices) agar FK pada cards &
 * access_logs terpenuhi. Mengembalikan id/identitas yang dibuat.
 */
function seedPrerequisites() {
  const device = db
    .prepare('INSERT INTO devices (device_id) VALUES (?)')
    .run('dev01');
  // room terikat ke device via UNIQUE(device_id)
  const roomA = db
    .prepare('INSERT INTO rooms (room_no, device_id) VALUES (?, ?)')
    .run('A-101', 'dev01');
  const roomB = db
    .prepare('INSERT INTO rooms (room_no) VALUES (?)')
    .run('A-102');
  const userA = db.prepare('INSERT INTO users (name) VALUES (?)').run('Budi');
  const userB = db.prepare('INSERT INTO users (name) VALUES (?)').run('Siti');

  return {
    deviceId: 'dev01',
    roomAId: Number(roomA.lastInsertRowid),
    roomBId: Number(roomB.lastInsertRowid),
    userAId: Number(userA.lastInsertRowid),
    userBId: Number(userB.lastInsertRowid),
  };
}

/** Insert satu kartu dengan binding opsional ke user/room. */
function insertCard(uid, { userId = null, roomId = null, status = 'ACTIVE' } = {}) {
  return db
    .prepare(
      'INSERT INTO cards (uid, user_id, room_id, status) VALUES (?, ?, ?, ?)'
    )
    .run(uid, userId, roomId, status);
}

/** Insert satu access_log dengan idempotency_key yang diberikan. */
function insertLog(
  idempotencyKey,
  { deviceId = 'dev01', uid = null, result = 'GRANT', syncType = 'REALTIME' } = {}
) {
  return db
    .prepare(
      `INSERT INTO access_logs (idempotency_key, device_id, uid, result, ts, sync_type)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(idempotencyKey, deviceId, uid, result, '2024-01-01T00:00:00.000Z', syncType);
}

describe('skema DB — constraint integritas (task 2.3)', () => {
  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    if (db && db.open) db.close();
  });

  it('foreign_keys pragma aktif pada instance factory', () => {
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });

  describe('cards — UNIQUE(uid) / PRIMARY KEY (Req 8.3)', () => {
    it('menolak insert kartu kedua dengan uid yang sama', () => {
      seedPrerequisites();
      insertCard('UID-AAA', { status: 'UNPROVISIONED' });

      expect(() => insertCard('UID-AAA', { status: 'UNPROVISIONED' })).toThrow(
        /UNIQUE constraint failed: cards\.uid/
      );
    });

    it('mengizinkan dua kartu dengan uid berbeda', () => {
      seedPrerequisites();
      insertCard('UID-AAA', { status: 'UNPROVISIONED' });

      expect(() => insertCard('UID-BBB', { status: 'UNPROVISIONED' })).not.toThrow();
      const count = db.prepare('SELECT COUNT(*) AS n FROM cards').get().n;
      expect(count).toBe(2);
    });
  });

  describe('cards — binding ketat satu-ke-satu (Req 8.4)', () => {
    it('menolak kartu kedua yang terikat ke user_id yang sama (UNIQUE(user_id))', () => {
      const { userAId, roomAId, roomBId } = seedPrerequisites();
      insertCard('UID-AAA', { userId: userAId, roomId: roomAId });

      expect(() =>
        insertCard('UID-BBB', { userId: userAId, roomId: roomBId })
      ).toThrow(/UNIQUE constraint failed: cards\.user_id/);
    });

    it('menolak kartu kedua yang terikat ke room_id yang sama (UNIQUE(room_id))', () => {
      const { userAId, userBId, roomAId } = seedPrerequisites();
      insertCard('UID-AAA', { userId: userAId, roomId: roomAId });

      expect(() =>
        insertCard('UID-BBB', { userId: userBId, roomId: roomAId })
      ).toThrow(/UNIQUE constraint failed: cards\.room_id/);
    });

    it('mengizinkan dua kartu dengan binding user & room yang berbeda', () => {
      const { userAId, userBId, roomAId, roomBId } = seedPrerequisites();
      insertCard('UID-AAA', { userId: userAId, roomId: roomAId });

      expect(() =>
        insertCard('UID-BBB', { userId: userBId, roomId: roomBId })
      ).not.toThrow();
    });
  });

  describe('access_logs — UNIQUE(idempotency_key) (Req 19.3)', () => {
    it('menolak dua log dengan idempotency_key yang sama', () => {
      seedPrerequisites();
      insertLog('idem-123');

      expect(() => insertLog('idem-123')).toThrow(
        /UNIQUE constraint failed: access_logs\.idempotency_key/
      );
    });

    it('mengizinkan dua log dengan idempotency_key berbeda', () => {
      seedPrerequisites();
      insertLog('idem-123');

      expect(() => insertLog('idem-456')).not.toThrow();
      const count = db.prepare('SELECT COUNT(*) AS n FROM access_logs').get().n;
      expect(count).toBe(2);
    });
  });

  describe('CHECK constraints', () => {
    it('menolak users.status yang tidak valid', () => {
      expect(() =>
        db.prepare('INSERT INTO users (name, status) VALUES (?, ?)').run('X', 'BOGUS')
      ).toThrow(/CHECK constraint failed/);
    });

    it('menolak cards.status yang tidak valid', () => {
      seedPrerequisites();
      expect(() => insertCard('UID-ZZZ', { status: 'BOGUS' })).toThrow(
        /CHECK constraint failed/
      );
    });

    it('menolak access_logs.result yang tidak valid', () => {
      seedPrerequisites();
      expect(() => insertLog('idem-r', { result: 'MAYBE' })).toThrow(
        /CHECK constraint failed/
      );
    });

    it('menolak access_logs.sync_type yang tidak valid', () => {
      seedPrerequisites();
      expect(() => insertLog('idem-s', { syncType: 'LATER' })).toThrow(
        /CHECK constraint failed/
      );
    });
  });
});
