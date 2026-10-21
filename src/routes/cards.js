'use strict';

/**
 * Router CRUD Card — Smart Door KOS ESP32 (WEB MODULE 1).
 *
 * Mengimplementasikan "cards.js — CRUD + bind kartu↔resident↔room (Req 8.3)"
 * dari design.md. Card dipetakan ke tabel `cards` (schema.sql):
 *   uid (PK, UNIQUE), user_id (UNIQUE FK users), room_id (UNIQUE FK rooms),
 *   key_version, status (ACTIVE|SUSPENDED|REVOKED|UNPROVISIONED), expired_at.
 *
 * Penegakan ketat satu-ke-satu (Req 8.4):
 *   Saat membuat/mengikat kartu, jika uid, user_id, ATAU room_id sudah terikat
 *   pada kartu lain, server MENOLAK dengan 409 Conflict — TANPA rebinding
 *   otomatis. Ini ditegakkan oleh constraint UNIQUE(uid)/UNIQUE(user_id)/
 *   UNIQUE(room_id) pada level DB; pelanggaran SQLITE_CONSTRAINT_UNIQUE
 *   (dan PRIMARYKEY untuk uid) diterjemahkan menjadi 409.
 *
 * Router dibuat via factory agar DB dapat di-inject untuk pengujian:
 *   const router = createCardsRouter({ db: createDatabase(':memory:') });
 *
 * Kontrak respons: 201 create, 200 read/update/list, 204 delete,
 * 400 input invalid, 404 tidak ditemukan, 409 konflik binding/FK.
 * Semua respons berupa JSON.
 *
 * _Requirements: 8.1, 8.2, 8.3, 8.4_
 */

const express = require('express');
const { getDb } = require('../db');
const { CARD_STATUS_VALUES } = require('../constants');

/**
 * Parse id numerik positif.
 * @param {*} raw
 * @returns {number|null}
 */
function parsePositiveInt(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return null;
  }
  return n;
}

/**
 * Terjemahkan error better-sqlite3 menjadi respons HTTP.
 * UNIQUE/PRIMARYKEY → 409 (uid/user_id/room_id sudah terikat — tanpa rebinding).
 * FOREIGNKEY → 409 (user_id/room_id merujuk resource yang tidak ada).
 * @param {Error & { code?: string, message?: string }} err
 * @param {import('express').Response} res
 * @returns {boolean} true bila sudah menangani respons.
 */
function handleSqliteError(err, res) {
  const code = err && err.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    // Identifikasi kolom pelanggaran dari pesan SQLite untuk diagnostik jelas.
    const msg = (err && err.message) || '';
    let field = 'uid, user_id, atau room_id';
    if (/cards\.user_id/.test(msg)) field = 'user_id';
    else if (/cards\.room_id/.test(msg)) field = 'room_id';
    else if (/cards\.uid/.test(msg)) field = 'uid';
    res.status(409).json({
      error: 'conflict',
      message: `${field} sudah terikat pada kartu lain; binding ketat satu-ke-satu, tanpa rebinding otomatis`,
    });
    return true;
  }
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    res.status(409).json({
      error: 'conflict',
      message: 'user_id atau room_id merujuk resource yang tidak ada',
    });
    return true;
  }
  return false;
}

/**
 * Validasi body create card.
 * uid wajib (string non-kosong). user_id/room_id opsional (integer positif atau
 * null). key_version opsional (integer positif, default 1). status opsional
 * (default 'UNPROVISIONED'). expired_at opsional (string ISO atau null).
 * @param {object} body
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
function validateCreate(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: 'body JSON wajib diisi' };
  }
  const { uid } = body;
  if (typeof uid !== 'string' || uid.trim().length === 0) {
    return { ok: false, message: 'uid wajib berupa string non-kosong' };
  }

  const value = { uid: uid.trim() };

  if (body.user_id != null) {
    const userId = parsePositiveInt(body.user_id);
    if (userId == null) {
      return { ok: false, message: 'user_id harus berupa integer positif atau null' };
    }
    value.user_id = userId;
  } else {
    value.user_id = null;
  }

  if (body.room_id != null) {
    const roomId = parsePositiveInt(body.room_id);
    if (roomId == null) {
      return { ok: false, message: 'room_id harus berupa integer positif atau null' };
    }
    value.room_id = roomId;
  } else {
    value.room_id = null;
  }

  if (body.key_version != null) {
    const kv = parsePositiveInt(body.key_version);
    if (kv == null) {
      return { ok: false, message: 'key_version harus berupa integer positif' };
    }
    value.key_version = kv;
  } else {
    value.key_version = 1;
  }

  if (body.status != null) {
    if (!CARD_STATUS_VALUES.includes(body.status)) {
      return {
        ok: false,
        message: `status harus salah satu dari ${CARD_STATUS_VALUES.join(', ')}`,
      };
    }
    value.status = body.status;
  } else {
    value.status = 'UNPROVISIONED';
  }

  if (body.expired_at != null && typeof body.expired_at !== 'string') {
    return { ok: false, message: 'expired_at harus berupa string ISO-8601 atau null' };
  }
  value.expired_at = body.expired_at != null ? body.expired_at : null;

  return { ok: true, value };
}

/**
 * Validasi body update card (partial). uid adalah identitas (PK) dan tidak
 * dapat diubah lewat endpoint ini.
 * @param {object} body
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
function validateUpdate(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: 'body JSON wajib diisi' };
  }
  const value = {};

  if ('user_id' in body) {
    if (body.user_id == null) {
      value.user_id = null;
    } else {
      const userId = parsePositiveInt(body.user_id);
      if (userId == null) {
        return { ok: false, message: 'user_id harus berupa integer positif atau null' };
      }
      value.user_id = userId;
    }
  }
  if ('room_id' in body) {
    if (body.room_id == null) {
      value.room_id = null;
    } else {
      const roomId = parsePositiveInt(body.room_id);
      if (roomId == null) {
        return { ok: false, message: 'room_id harus berupa integer positif atau null' };
      }
      value.room_id = roomId;
    }
  }
  if ('key_version' in body) {
    const kv = parsePositiveInt(body.key_version);
    if (kv == null) {
      return { ok: false, message: 'key_version harus berupa integer positif' };
    }
    value.key_version = kv;
  }
  if ('status' in body) {
    if (!CARD_STATUS_VALUES.includes(body.status)) {
      return {
        ok: false,
        message: `status harus salah satu dari ${CARD_STATUS_VALUES.join(', ')}`,
      };
    }
    value.status = body.status;
  }
  if ('expired_at' in body) {
    if (body.expired_at != null && typeof body.expired_at !== 'string') {
      return { ok: false, message: 'expired_at harus berupa string ISO-8601 atau null' };
    }
    value.expired_at = body.expired_at != null ? body.expired_at : null;
  }

  if (Object.keys(value).length === 0) {
    return { ok: false, message: 'tidak ada field yang dapat diperbarui' };
  }
  return { ok: true, value };
}

/**
 * Factory router CRUD card.
 * @param {{ db?: import('better-sqlite3').Database }} [deps]
 * @returns {import('express').Router}
 */
function createCardsRouter({ db = getDb() } = {}) {
  const router = express.Router();
  const selectByUid = db.prepare('SELECT * FROM cards WHERE uid = ?');

  // CREATE / bind
  router.post('/', (req, res) => {
    const parsed = validateCreate(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: 'bad_request', message: parsed.message });
    }
    try {
      db.prepare(
        `INSERT INTO cards (uid, user_id, room_id, key_version, status, expired_at)
         VALUES (@uid, @user_id, @room_id, @key_version, @status, @expired_at)`
      ).run(parsed.value);
      return res.status(201).json(selectByUid.get(parsed.value.uid));
    } catch (err) {
      if (handleSqliteError(err, res)) return undefined;
      throw err;
    }
  });

  // LIST
  router.get('/', (_req, res) => {
    const rows = db.prepare('SELECT * FROM cards ORDER BY uid').all();
    return res.status(200).json(rows);
  });

  // READ :uid
  router.get('/:uid', (req, res) => {
    const row = selectByUid.get(req.params.uid);
    if (!row) {
      return res.status(404).json({ error: 'not_found', message: 'card tidak ditemukan' });
    }
    return res.status(200).json(row);
  });

  // UPDATE :uid
  router.put('/:uid', (req, res) => {
    const parsed = validateUpdate(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: 'bad_request', message: parsed.message });
    }
    const existing = selectByUid.get(req.params.uid);
    if (!existing) {
      return res.status(404).json({ error: 'not_found', message: 'card tidak ditemukan' });
    }
    const next = {
      user_id: 'user_id' in parsed.value ? parsed.value.user_id : existing.user_id,
      room_id: 'room_id' in parsed.value ? parsed.value.room_id : existing.room_id,
      key_version: 'key_version' in parsed.value ? parsed.value.key_version : existing.key_version,
      status: 'status' in parsed.value ? parsed.value.status : existing.status,
      expired_at: 'expired_at' in parsed.value ? parsed.value.expired_at : existing.expired_at,
    };
    try {
      db.prepare(
        `UPDATE cards
           SET user_id = @user_id,
               room_id = @room_id,
               key_version = @key_version,
               status = @status,
               expired_at = @expired_at,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE uid = @uid`
      ).run({ ...next, uid: req.params.uid });
      return res.status(200).json(selectByUid.get(req.params.uid));
    } catch (err) {
      if (handleSqliteError(err, res)) return undefined;
      throw err;
    }
  });

  // DELETE :uid
  router.delete('/:uid', (req, res) => {
    const info = db.prepare('DELETE FROM cards WHERE uid = ?').run(req.params.uid);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'not_found', message: 'card tidak ditemukan' });
    }
    return res.status(204).end();
  });

  return router;
}

module.exports = createCardsRouter;
