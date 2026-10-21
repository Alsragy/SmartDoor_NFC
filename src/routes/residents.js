'use strict';

/**
 * Router CRUD Resident — Smart Door KOS ESP32 (WEB MODULE 1).
 *
 * Mengimplementasikan "residents.js — CRUD resident (Req 8.1)" dari design.md.
 * Resident dipetakan ke tabel `users` (lihat schema.sql): kolom name, phone,
 * status (ACTIVE|INACTIVE).
 *
 * Router dibuat via factory agar DB dapat di-inject untuk pengujian:
 *   const router = createResidentsRouter({ db: createDatabase(':memory:') });
 * Tanpa argumen, factory memakai instance DB bersama via getDb().
 *
 * Kontrak respons:
 *   - 201 pada create (mengembalikan entitas lengkap).
 *   - 200 pada read/update/list.
 *   - 400 pada input tidak valid (body/parameter).
 *   - 404 bila resource tidak ditemukan.
 *   - 204 pada delete sukses.
 * Semua respons berupa JSON.
 *
 * _Requirements: 8.1_
 */

const express = require('express');
const { getDb } = require('../db');

/** Status resident yang valid (selaras CHECK pada users.status). */
const RESIDENT_STATUS = Object.freeze(['ACTIVE', 'INACTIVE']);

/**
 * Parse id numerik dari parameter path.
 * @param {string} raw
 * @returns {number|null} integer positif, atau null bila tidak valid.
 */
function parseId(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return null;
  }
  return n;
}

/**
 * Validasi & normalisasi body untuk create resident.
 * name wajib (string non-kosong). phone opsional (string). status opsional,
 * default 'ACTIVE', harus salah satu dari RESIDENT_STATUS.
 * @param {object} body
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
function validateCreate(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: 'body JSON wajib diisi' };
  }
  const { name, phone, status } = body;
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, message: 'name wajib berupa string non-kosong' };
  }
  if (phone != null && typeof phone !== 'string') {
    return { ok: false, message: 'phone harus berupa string' };
  }
  if (status != null && !RESIDENT_STATUS.includes(status)) {
    return {
      ok: false,
      message: `status harus salah satu dari ${RESIDENT_STATUS.join(', ')}`,
    };
  }
  return {
    ok: true,
    value: {
      name: name.trim(),
      phone: phone != null ? phone : null,
      status: status != null ? status : 'ACTIVE',
    },
  };
}

/**
 * Validasi & normalisasi body untuk update resident (partial allowed).
 * Minimal satu field yang dapat diubah harus disertakan.
 * @param {object} body
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
function validateUpdate(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: 'body JSON wajib diisi' };
  }
  const value = {};
  if ('name' in body) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return { ok: false, message: 'name harus berupa string non-kosong' };
    }
    value.name = body.name.trim();
  }
  if ('phone' in body) {
    if (body.phone != null && typeof body.phone !== 'string') {
      return { ok: false, message: 'phone harus berupa string' };
    }
    value.phone = body.phone != null ? body.phone : null;
  }
  if ('status' in body) {
    if (!RESIDENT_STATUS.includes(body.status)) {
      return {
        ok: false,
        message: `status harus salah satu dari ${RESIDENT_STATUS.join(', ')}`,
      };
    }
    value.status = body.status;
  }
  if (Object.keys(value).length === 0) {
    return { ok: false, message: 'tidak ada field yang dapat diperbarui' };
  }
  return { ok: true, value };
}

/**
 * Factory router CRUD resident.
 * @param {{ db?: import('better-sqlite3').Database }} [deps]
 * @returns {import('express').Router}
 */
function createResidentsRouter({ db = getDb() } = {}) {
  const router = express.Router();

  /** Ambil satu resident berdasarkan id. */
  const selectById = db.prepare('SELECT * FROM users WHERE id = ?');

  // CREATE
  router.post('/', (req, res) => {
    const parsed = validateCreate(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: 'bad_request', message: parsed.message });
    }
    const info = db
      .prepare('INSERT INTO users (name, phone, status) VALUES (@name, @phone, @status)')
      .run(parsed.value);
    const created = selectById.get(info.lastInsertRowid);
    return res.status(201).json(created);
  });

  // LIST
  router.get('/', (_req, res) => {
    const rows = db.prepare('SELECT * FROM users ORDER BY id').all();
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
      return res.status(404).json({ error: 'not_found', message: 'resident tidak ditemukan' });
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
      return res.status(404).json({ error: 'not_found', message: 'resident tidak ditemukan' });
    }
    const next = {
      name: 'name' in parsed.value ? parsed.value.name : existing.name,
      phone: 'phone' in parsed.value ? parsed.value.phone : existing.phone,
      status: 'status' in parsed.value ? parsed.value.status : existing.status,
    };
    db.prepare(
      `UPDATE users
         SET name = @name,
             phone = @phone,
             status = @status,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = @id`
    ).run({ ...next, id });
    return res.status(200).json(selectById.get(id));
  });

  // DELETE :id
  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (id == null) {
      return res.status(400).json({ error: 'bad_request', message: 'id tidak valid' });
    }
    const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'not_found', message: 'resident tidak ditemukan' });
    }
    return res.status(204).end();
  });

  return router;
}

module.exports = createResidentsRouter;
module.exports.RESIDENT_STATUS = RESIDENT_STATUS;
