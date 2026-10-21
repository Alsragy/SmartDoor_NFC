'use strict';

/**
 * Endpoint Unduh Whitelist & Delta Sync — Smart Door KOS ESP32 (Web Server).
 *
 * Mengimplementasikan jalur HTTP REST untuk firmware mengambil daftar kartu
 * valid sebuah device (Req 7.2) beserta sinkronisasi delta berbasis versi
 * (Req 4.3). Device membaca whitelist aktif ini sebagai sumber keputusan akses
 * saat offline (Req 4.1).
 *
 * Rute (lihat design.md "REST API Endpoint"):
 *   GET /api/devices/:dev/whitelist
 *     → whitelist PENUH kartu aktif yang dilayani device `:dev`.
 *     Bentuk: { db_version, db_hash, cards: [ { uid, key_version, status,
 *               expired_at }, ... ] }. REVOKED/UNPROVISIONED dikecualikan
 *     (hanya kartu aktif firmware yang dikirim — Req 10.2).
 *
 *   GET /api/devices/:dev/whitelist?since_version=N
 *     → DELTA via whitelistVersion.computeDelta terhadap seluruh kartu device.
 *     Bentuk: { changed:[...], removed:[uid,...], db_version, db_hash }.
 *
 * Keduanya mengembalikan `db_version`/`db_hash` snapshot agar firmware dapat
 * memverifikasi konsistensi whitelist (Property 7).
 *
 * `404 Not Found` bila device `:dev` tidak terdaftar.
 *
 * Relasi data: kartu terikat ke room (cards.room_id → rooms.id), dan room
 * dilayani satu device (rooms.device_id → devices.device_id). Whitelist sebuah
 * device = seluruh kartu yang room-nya dilayani device tersebut.
 *
 * Catatan: router ini TIDAK memasang middleware API_Key. Proteksi API_Key
 * (Req 7.3/7.4) dipasang saat router di-mount pada app (task 18).
 *
 * Modul menerima `db` yang dapat diinjeksi (default instance bersama getDb())
 * agar dapat diuji dengan createDatabase(':memory:').
 *
 * _Requirements: 4.1, 4.3, 7.2_
 */

const express = require('express');

const { getDb } = require('../db');
const whitelistVersion = require('../services/whitelistVersion');

/**
 * SQL: seluruh kartu yang dilayani sebuah device, lewat join
 * cards → rooms → devices berdasarkan device_id. Diurutkan berdasar uid agar
 * deterministik (hash tetap stabil terhadap urutan baca).
 */
const SELECT_DEVICE_CARDS_SQL = `
  SELECT c.uid        AS uid,
         c.key_version AS key_version,
         c.status     AS status,
         c.expired_at AS expired_at,
         c.db_version AS db_version
    FROM cards   AS c
    JOIN rooms   AS r ON c.room_id = r.id
    JOIN devices AS d ON r.device_id = d.device_id
   WHERE d.device_id = @device_id
   ORDER BY c.uid ASC
`;

/** SQL: cek keberadaan sebuah device. */
const SELECT_DEVICE_EXISTS_SQL = `
  SELECT 1 AS present FROM devices WHERE device_id = @device_id LIMIT 1
`;

/**
 * Apakah device terdaftar pada basis data.
 * @param {import('better-sqlite3').Database} db
 * @param {string} deviceId
 * @returns {boolean}
 */
function deviceExists(db, deviceId) {
  const row = db.prepare(SELECT_DEVICE_EXISTS_SQL).get({ device_id: deviceId });
  return Boolean(row);
}

/**
 * Ambil seluruh kartu yang dilayani sebuah device (termasuk REVOKED/
 * UNPROVISIONED — penyaringan dilakukan pemanggil sesuai kebutuhan).
 * @param {import('better-sqlite3').Database} db
 * @param {string} deviceId
 * @returns {Array<{uid:string, key_version:number, status:string, expired_at:?string, db_version:number}>}
 */
function selectDeviceCards(db, deviceId) {
  return db.prepare(SELECT_DEVICE_CARDS_SQL).all({ device_id: deviceId });
}

/**
 * Hitung `db_version` snapshot device = db_version maksimum di antara seluruh
 * kartu device (monotonik, konsisten dengan whitelistVersion.computeDelta).
 * 0 bila device belum punya kartu.
 * @param {Array<{db_version?:number}>} cards
 * @returns {number}
 */
function maxDbVersion(cards) {
  let max = 0;
  for (const card of cards) {
    const v = Number(card.db_version);
    if (Number.isFinite(v) && v > max) {
      max = v;
    }
  }
  return max;
}

/**
 * Bentuk entri kartu publik untuk whitelist penuh (hanya field yang relevan
 * bagi firmware — tanpa db_version internal). Lihat design.md whitelist.json.
 * @param {{uid:string, key_version:number, status:string, expired_at:?string}} card
 * @returns {{uid:string, key_version:number, status:string, expired_at:?string}}
 */
function toPublicCard(card) {
  return {
    uid: card.uid,
    key_version: card.key_version,
    status: card.status,
    expired_at: card.expired_at ?? null,
  };
}

/**
 * Parse query `since_version`. Mengembalikan:
 *   - null bila tidak disertakan (→ permintaan whitelist penuh).
 *   - number (>= 0) bila valid (→ permintaan delta).
 *   - undefined bila disertakan namun tidak valid (→ 400 di handler).
 * @param {*} raw nilai req.query.since_version.
 * @returns {number|null|undefined}
 */
function parseSinceVersion(raw) {
  if (raw === undefined) {
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return undefined;
  }
  return n;
}

/**
 * Factory router whitelist. Menerima `db` yang dapat diinjeksi.
 * @param {{ db?: import('better-sqlite3').Database }} [deps]
 * @returns {import('express').Router}
 */
function createWhitelistRouter({ db = getDb() } = {}) {
  const router = express.Router();

  router.get('/api/devices/:dev/whitelist', (req, res) => {
    const deviceId = req.params.dev;

    // 404 bila device tidak terdaftar (Req 7.2: unduhan per-device).
    if (!deviceExists(db, deviceId)) {
      res.status(404).json({
        error: 'device_not_found',
        message: `Device "${deviceId}" tidak ditemukan`,
      });
      return;
    }

    const sinceVersion = parseSinceVersion(req.query.since_version);
    if (sinceVersion === undefined) {
      res.status(400).json({
        error: 'invalid_since_version',
        message: 'Parameter since_version harus bilangan bulat non-negatif',
      });
      return;
    }

    const serverCards = selectDeviceCards(db, deviceId);

    // Mode DELTA: since_version disertakan → kembalikan perubahan sejak versi itu.
    if (sinceVersion !== null) {
      const delta = whitelistVersion.computeDelta(sinceVersion, serverCards);
      res.status(200).json({
        changed: delta.changed.map(toPublicCard),
        removed: delta.removed,
        db_version: delta.db_version,
        db_hash: delta.db_hash,
      });
      return;
    }

    // Mode PENUH: seluruh kartu aktif (REVOKED/UNPROVISIONED dikecualikan).
    const active = whitelistVersion.activeCards(serverCards);
    res.status(200).json({
      db_version: maxDbVersion(serverCards),
      db_hash: whitelistVersion.dbHash(active),
      cards: active.map(toPublicCard),
    });
  });

  return router;
}

module.exports = {
  createWhitelistRouter,
  // Diekspos untuk keperluan uji & pemakaian lanjutan.
  parseSinceVersion,
  maxDbVersion,
  toPublicCard,
};
