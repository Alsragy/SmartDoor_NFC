'use strict';

/**
 * Router CRUD Room — Smart Door KOS ESP32 (WEB MODULE 1).
 *
 * Mengimplementasikan "rooms.js — CRUD room (Req 8.2)" dari design.md.
 * Room dipetakan ke tabel `rooms` (schema.sql): kolom room_no (UNIQUE) dan
 * device_id (UNIQUE FK ke devices, nullable — satu kamar dilayani satu device).
 *
 * Router dibuat via factory agar DB dapat di-inject untuk pengujian:
 *   const router = createRoomsRouter({ db: createDatabase(':memory:') });
 *
 * Kontrak respons:
 *   - 201 pada create, 200 pada read/update/list, 204 pada delete.
 *   - 400 input tidak valid, 404 resource tidak ditemukan.
 *   - 409 bila room_no / device_id sudah dipakai (pelanggaran UNIQUE),
 *     atau device_id merujuk device yang tidak ada (pelanggaran FK).
 * Semua respons berupa JSON.
 *
 * _Requirements: 8.2_
 */

const express = require('express');
const { getDb } = require('../db');

/**
 * Parse id numerik dari parameter path.
 * @param {string} raw
 * @returns {number|null}
 */
function parseId(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return null;
  }
  return n;
}

/**
 * Terjemahkan error better-sqlite3 menjadi respons HTTP yang sesuai.
 * UNIQUE → 409 Conflict; FOREIGNKEY → 409 (device_id tidak valid).
 * Mengembalikan true bila sudah menangani respons.
 * @param {Error & { code?: string }} err
 * @param {import('express').Response} res
 * @returns {boolean}
 */
function handleSqliteError(err, res) {
  const code = err && err.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    res.status(409).json({
      error: 'conflict',
      message: 'room_no atau device_id sudah digunakan',
    });
    return true;
  }
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    res.status(409).json({
      error: 'conflict',
      message: 'device_id merujuk device yang tidak ada',
    });
    return true;
  }
  return false;
}

/**
 * Validasi body create room.
 * room_no wajib (string non-kosong). device_id opsional (string non-kosong
 * atau null).
 * @param {object} body
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
function validateCreate(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: 'body JSON wajib diisi' };
  }
  const { room_no: roomNo, device_id: deviceId } = body;
  if (typeof roomNo !== 'string' || roomNo.trim().length === 0) {
    return { ok: false, message: 'room_no wajib berupa string non-kosong' };
  }
  if (deviceId != null && (typeof deviceId !== 'string' || deviceId.trim().length === 0)) {
    return { ok: false, message: 'device_id harus berupa string non-kosong atau null' };
  }
  return {
    ok: true,
    value: {
      room_no: roomNo.trim(),
      device_id: deviceId != null ? deviceId.trim() : null,
    },
  };
}

/**
 * Validasi body update room (partial).
 * @param {object} body
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
function validateUpdate(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: 'body JSON wajib diisi' };
  }
  const value = {};
  if ('room_no' in body) {
    if (typeof body.room_no !== 'string' || body.room_no.trim().length === 0) {
      return { ok: false, message: 'room_no harus berupa string non-kosong' };
    }
    value.room_no = body.room_no.trim();
  }
  if ('device_id' in body) {
    if (
      body.device_id != null &&
      (typeof body.device_id !== 'string' || body.device_id.trim().length === 0)
    ) {
      return { ok: false, message: 'device_id harus berupa string non-kosong atau null' };
    }
    value.device_id = body.device_id != null ? body.device_id.trim() : null;
  }
  if (Object.keys(value).length === 0) {
    return { ok: false, message: 'tidak ada field yang dapat diperbarui' };
  }
  return { ok: true, value };
}

/**
 * Factory router CRUD room.
 * @param {{ db?: import('better-sqlite3').Database }} [deps]
 * @returns {import('express').Router}
 */
function createRoomsRouter({ db = getDb() } = {}) {
  const router = express.Router();
  const selectById = db.prepare('SELECT * FROM rooms WHERE id = ?');

  // CREATE
  router.post('/', (req, res) => {
    const parsed = validateCreate(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: 'bad_request', message: parsed.message });
    }
    try {
      const info = db
        .prepare('INSERT INTO rooms (room_no, device_id) VALUES (@room_no, @device_id)')
        .run(parsed.value);
      return res.status(201).json(selectById.get(info.lastInsertRowid));
    } catch (err) {
      if (handleSqliteError(err, res)) return undefined;
      throw err;
    }
  });

  // LIST
  router.get('/', (_req, res) => {
    const rows = db.prepare('SELECT * FROM rooms ORDER BY id').all();
    return res.status(200).json(rows);
  });

  // READ :id
  router.get('/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (id == null) {
      return res.status(400).json({ error: 'bad_request', message: 'id tidak valid' });
    }
    const row = selectById.get(id);
    if (!row) {
      return res.status(404).json({ error: 'not_found', message: 'room tidak ditemukan' });
    }
    return res.status(200).json(row);
  });

  // UPDATE :id
  router.put('/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (id == null) {
      return res.status(400).json({ error: 'bad_request', message: 'id tidak valid' });
    }
    const parsed = validateUpdate(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: 'bad_request', message: parsed.message });
    }
    const existing = selectById.get(id);
    if (!existing) {
      return res.status(404).json({ error: 'not_found', message: 'room tidak ditemukan' });
    }
    const next = {
      room_no: 'room_no' in parsed.value ? parsed.value.room_no : existing.room_no,
      device_id: 'device_id' in parsed.value ? parsed.value.device_id : existing.device_id,
    };
    try {
      db.prepare(
        `UPDATE rooms
           SET room_no = @room_no,
               device_id = @device_id,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = @id`
      ).run({ ...next, id });
      return res.status(200).json(selectById.get(id));
    } catch (err) {
      if (handleSqliteError(err, res)) return undefined;
      throw err;
    }
  });

  // DELETE :id
  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (id == null) {
      return res.status(400).json({ error: 'bad_request', message: 'id tidak valid' });
    }
    const info = db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'not_found', message: 'room tidak ditemukan' });
    }
    return res.status(204).end();
  });

  return router;
}

module.exports = createRoomsRouter;
