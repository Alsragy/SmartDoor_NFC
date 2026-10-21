'use strict';

/**
 * Provisioning Kartu + Derivasi Kunci — Smart Door KOS ESP32 (Web Server).
 *
 * Mengimplementasikan "Provisioning Kartu + Derivasi Kunci (Req 2)" dari
 * design.md. Menyediakan factory Router Express:
 *
 *     POST /api/provisioning  { uid, resident_id, room_id, expired_at }
 *
 * Alur (lihat sequence diagram design.md):
 *   1. Validasi input (uid, resident_id/user_id, room_id wajib).
 *   2. Turunkan Diversified_Key dari Master_Key + UID via `keyDerivation.derive`
 *      (Master_Key dibaca dari env via `loadMasterKey`, TIDAK di-hardcode).
 *   3. Tulis Diversified_Key ke kartu fisik via abstraksi `cardWriter.write`.
 *      Lingkungan ini tidak punya penulis NFC nyata, jadi default-nya stub yang
 *      selalu sukses; route tetap menangani writer yang melempar/gagal.
 *   4. Bila penulisan sukses → upsert baris kartu `status='ACTIVE'`,
 *      `key_version`, `expired_at` (atribut billing Req 9.1), naikkan
 *      `db_version` kartu & device terkait; respons `201 Created`.
 *   5. Bila gagal (writer melempar/mengembalikan gagal, atau error lain) →
 *      upsert kartu `status='UNPROVISIONED'` dan kembalikan kode kesalahan
 *      (Req 2.3).
 *
 * Binding satu-ke-satu user_id/room_id/uid ditegakkan oleh constraint UNIQUE
 * di schema; pelanggaran dipetakan ke `409 Conflict` (konsisten dengan task
 * 15.1), kartu tetap ditandai `UNPROVISIONED`.
 *
 * `db`/`cardWriter` di-inject agar dapat diuji (sukses & gagal) tanpa
 * perangkat NFC nyata dan tanpa menyentuh DB bersama.
 *
 * _Requirements: 2.1, 2.2, 2.3, 9.1_
 */

const express = require('express');

const { getDb } = require('../db');
const keyDerivation = require('../services/keyDerivation');
const whitelistVersion = require('../services/whitelistVersion');
const { CARD_STATUS } = require('../constants');

/**
 * Penulis kartu default (stub) untuk lingkungan tanpa reader NFC nyata.
 * Selalu sukses. Pada deployment nyata, ganti dengan implementasi yang
 * benar-benar menuliskan `diversifiedKey` ke Crypto_Card via NFC_Reader.
 */
const defaultCardWriter = {
  /**
   * Tulis Diversified_Key ke kartu.
   * @param {string} uid UID kartu.
   * @param {Buffer} diversifiedKey kunci per-kartu 16-byte.
   * @returns {{ ok: true }}
   */
  write(uid, diversifiedKey) {
    void uid;
    void diversifiedKey;
    return { ok: true };
  },
};

/** Error provisioning dengan kode HTTP & kode mesin yang terbawa. */
class ProvisioningError extends Error {
  /**
   * @param {number} statusCode kode HTTP (4xx/5xx).
   * @param {string} code kode mesin, mis. 'write_failed'.
   * @param {string} message pesan manusiawi.
   */
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ProvisioningError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Normalisasi & validasi payload provisioning.
 * Menerima `resident_id` (alias `user_id`) demi kenyamanan API.
 * @param {object} body body JSON request.
 * @returns {{ uid: string, userId: number, roomId: number, expiredAt: (string|null) }}
 * @throws {ProvisioningError} 400 bila input tidak valid.
 */
function parseBody(body) {
  const b = body && typeof body === 'object' ? body : {};

  const uid = typeof b.uid === 'string' ? b.uid.trim() : '';
  if (!uid) {
    throw new ProvisioningError(400, 'invalid_uid', 'uid wajib diisi (string non-kosong).');
  }

  const userIdRaw = b.resident_id !== undefined ? b.resident_id : b.user_id;
  const userId = Number.parseInt(userIdRaw, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new ProvisioningError(
      400,
      'invalid_resident_id',
      'resident_id (user_id) wajib berupa integer positif.',
    );
  }

  const roomId = Number.parseInt(b.room_id, 10);
  if (!Number.isInteger(roomId) || roomId <= 0) {
    throw new ProvisioningError(400, 'invalid_room_id', 'room_id wajib berupa integer positif.');
  }

  // expired_at opsional (billing-lock, Req 9.1); null bila tidak diberikan.
  let expiredAt = null;
  if (b.expired_at !== undefined && b.expired_at !== null && b.expired_at !== '') {
    if (typeof b.expired_at !== 'string') {
      throw new ProvisioningError(
        400,
        'invalid_expired_at',
        'expired_at harus berupa string ISO-8601 bila diberikan.',
      );
    }
    expiredAt = b.expired_at;
  }

  return { uid, userId, roomId, expiredAt };
}

/**
 * Apakah error better-sqlite3 merupakan pelanggaran UNIQUE/constraint.
 * @param {*} err
 * @returns {boolean}
 */
function isUniqueViolation(err) {
  const code = err && err.code;
  return (
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    code === 'SQLITE_CONSTRAINT'
  );
}

/**
 * Tandai/insert kartu sebagai UNPROVISIONED (best-effort) saat provisioning
 * gagal (Req 2.3). Tidak melempar bila gagal sekunder (mis. bentrok binding
 * yang justru jadi penyebab awal kegagalan); kegagalan dicatat tanpa menutupi
 * error utama.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ uid: string, userId: number, roomId: number, expiredAt: (string|null), keyVersion: number }} fields
 */
function markUnprovisioned(db, fields) {
  const { uid, keyVersion } = fields;
  const cardHash = whitelistVersion.cardHash({
    uid,
    key_version: keyVersion,
    status: CARD_STATUS.UNPROVISIONED,
    expired_at: fields.expiredAt,
  });

  try {
    // Jika baris sudah ada (mis. karena uid sama), cukup set status tanpa
    // menyentuh binding user/room agar tidak memicu pelanggaran UNIQUE baru.
    const existing = db.prepare('SELECT uid FROM cards WHERE uid = ?').get(uid);
    if (existing) {
      db.prepare(
        `UPDATE cards
            SET status = ?,
                key_version = ?,
                card_hash = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE uid = ?`,
      ).run(CARD_STATUS.UNPROVISIONED, keyVersion, cardHash, uid);
      return;
    }

    // Insert baru sebagai UNPROVISIONED. Sertakan binding bila itu tidak
    // bentrok; bila bentrok, insert tanpa binding agar jejak kartu tetap ada.
    try {
      db.prepare(
        `INSERT INTO cards (uid, user_id, room_id, key_version, status, expired_at, card_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        uid,
        fields.userId,
        fields.roomId,
        keyVersion,
        CARD_STATUS.UNPROVISIONED,
        fields.expiredAt,
        cardHash,
      );
    } catch (bindErr) {
      if (isUniqueViolation(bindErr)) {
        db.prepare(
          `INSERT INTO cards (uid, key_version, status, expired_at, card_hash)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(uid, keyVersion, CARD_STATUS.UNPROVISIONED, fields.expiredAt, cardHash);
      } else {
        throw bindErr;
      }
    }
  } catch (markErr) {
    // Best-effort: jangan menutupi error provisioning utama.
    // eslint-disable-next-line no-console
    console.error('provisioning: gagal menandai kartu UNPROVISIONED:', markErr.message);
  }
}

/**
 * Lakukan provisioning aktif (sukses path) dalam satu transaksi:
 *   - upsert kartu ACTIVE + key_version + expired_at,
 *   - naikkan db_version kartu,
 *   - naikkan db_version device terkait room (bila ada).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ uid: string, userId: number, roomId: number, expiredAt: (string|null), keyVersion: number }} fields
 * @returns {object} baris kartu hasil provisioning.
 * @throws {ProvisioningError} 409 bila binding bentrok.
 */
function persistActiveCard(db, fields) {
  const { uid, userId, roomId, expiredAt, keyVersion } = fields;

  const runTx = typeof db.tx === 'function'
    ? db.tx
    : (fn) => db.transaction(() => fn(db))();

  try {
    return runTx(() => {
      // db_version kartu baru = max(db_version) global + 1 (monotonik).
      const row = db.prepare('SELECT COALESCE(MAX(db_version), 0) AS maxv FROM cards').get();
      const nextVersion = Number(row.maxv) + 1;

      const cardHash = whitelistVersion.cardHash({
        uid,
        key_version: keyVersion,
        status: CARD_STATUS.ACTIVE,
        expired_at: expiredAt,
      });

      db.prepare(
        `INSERT INTO cards (uid, user_id, room_id, key_version, status, expired_at, db_version, card_hash)
         VALUES (@uid, @userId, @roomId, @keyVersion, @status, @expiredAt, @dbVersion, @cardHash)
         ON CONFLICT(uid) DO UPDATE SET
           user_id     = excluded.user_id,
           room_id     = excluded.room_id,
           key_version = excluded.key_version,
           status      = excluded.status,
           expired_at  = excluded.expired_at,
           db_version  = excluded.db_version,
           card_hash   = excluded.card_hash,
           updated_at  = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ).run({
        uid,
        userId,
        roomId,
        keyVersion,
        status: CARD_STATUS.ACTIVE,
        expiredAt,
        dbVersion: nextVersion,
        cardHash,
      });

      // Naikkan db_version device yang melayani room ini (delta sync, Req 4.3).
      db.prepare(
        `UPDATE devices
            SET db_version = db_version + 1,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE device_id = (SELECT device_id FROM rooms WHERE id = ?)`,
      ).run(roomId);

      return db.prepare('SELECT * FROM cards WHERE uid = ?').get(uid);
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ProvisioningError(
        409,
        'binding_conflict',
        'uid, resident_id, atau room_id sudah terikat ke kartu lain (binding satu-ke-satu).',
      );
    }
    throw err;
  }
}

/**
 * Buat Router Express untuk endpoint provisioning.
 *
 * @param {object} [deps]
 * @param {import('better-sqlite3').Database} [deps.db] instance DB; default
 *   instance bersama via `getDb()`.
 * @param {{ write: (uid: string, diversifiedKey: Buffer) => any }} [deps.cardWriter]
 *   abstraksi penulis kartu; default stub yang selalu sukses.
 * @returns {import('express').Router}
 */
function createProvisioningRouter({ db, cardWriter } = {}) {
  const router = express.Router();
  const writer = cardWriter || defaultCardWriter;
  const database = db || getDb();

  router.post('/api/provisioning', (req, res) => {
    let fields;
    try {
      fields = parseBody(req.body);
    } catch (err) {
      if (err instanceof ProvisioningError) {
        res.status(err.statusCode).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }

    // Derivasi kunci (Master_Key dari env, tidak di-hardcode).
    let diversifiedKey;
    let keyVersion;
    try {
      const masterKey = keyDerivation.loadMasterKey();
      const derived = keyDerivation.derive(masterKey, fields.uid);
      diversifiedKey = derived.diversifiedKey;
      keyVersion = derived.keyVersion;
    } catch (err) {
      // Gagal derivasi dianggap kegagalan provisioning (Req 2.3).
      markUnprovisioned(database, { ...fields, keyVersion: keyDerivation.DEFAULT_KEY_VERSION });
      res.status(500).json({
        error: 'key_derivation_failed',
        message: 'Gagal menurunkan Diversified_Key.',
      });
      return;
    }

    const full = { ...fields, keyVersion };

    // Tulis kunci ke kartu fisik via abstraksi writer.
    let writeResult;
    try {
      writeResult = writer.write(fields.uid, diversifiedKey);
    } catch (err) {
      markUnprovisioned(database, full);
      res.status(502).json({
        error: 'card_write_failed',
        message: `Gagal menulis kunci ke kartu: ${err.message}`,
      });
      return;
    }

    // Writer boleh mengembalikan { ok: false } untuk menandai kegagalan halus.
    if (writeResult && writeResult.ok === false) {
      markUnprovisioned(database, full);
      res.status(502).json({
        error: 'card_write_failed',
        message: writeResult.message || 'Penulisan kunci ke kartu tidak berhasil.',
      });
      return;
    }

    // Penulisan sukses → persist kartu ACTIVE.
    let card;
    try {
      card = persistActiveCard(database, full);
    } catch (err) {
      markUnprovisioned(database, full);
      if (err instanceof ProvisioningError) {
        res.status(err.statusCode).json({ error: err.code, message: err.message });
        return;
      }
      res.status(500).json({
        error: 'provisioning_failed',
        message: `Provisioning gagal: ${err.message}`,
      });
      return;
    }

    res.status(201).json({
      uid: card.uid,
      user_id: card.user_id,
      room_id: card.room_id,
      key_version: card.key_version,
      status: card.status,
      expired_at: card.expired_at,
      db_version: card.db_version,
    });
  });

  return router;
}

module.exports = {
  createProvisioningRouter,
  defaultCardWriter,
  ProvisioningError,
};
