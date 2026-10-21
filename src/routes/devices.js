'use strict';

/**
 * Device Health & Remote Unlock — route REST (Smart Door KOS ESP32).
 *
 * Mengimplementasikan design.md "Device Health (Req 11)" dan
 * "Remote Unlock (Req 12)":
 *
 *   A->>API: POST /api/devices/{dev}/unlock (API_Key)
 *   API->>MQ: publish smartdoor/{dev}/cmd/unlock { API_Key, nonce }
 *   MQ->>F : perintah unlock → firmware validasi API_Key & gerakkan relay
 *
 * Tanggung jawab (task 17.1):
 *   - `GET /api/devices` : daftar semua device beserta status terhitung
 *     ONLINE/OFFLINE (deviceHealth.status atas last_seen, now, offlineIntervalMs)
 *     plus rssi, fs_free, db_version (Req 11.2, 11.3, 11.4).
 *   - `GET /api/devices/:dev` : kesehatan satu device; 404 bila tidak ada.
 *   - `POST /api/devices/:dev/unlock` : bangkitkan nonce, publish `cmd/unlock`
 *     via `publisher.publishUnlock(deviceId, { nonce })`; 404 bila device tidak
 *     ada; 200 pada sukses dengan nonce & topik yang diterbitkan (Req 12.1, 12.2).
 *
 * Status Online/Offline dihitung MURNI dari telemetri tersimpan (last_seen)
 * terhadap ambang `offlineIntervalMs`. Modul deviceHealth bersifat deterministik
 * (tanpa I/O); waktu `now` diinjeksikan dari sini (Date.now()) agar router tetap
 * mudah diuji.
 *
 * Ketahanan publish (catatan Req 12.4): aktuasi relay TIDAK diwajibkan
 * melaporkan kegagalan kembali ke dashboard — namun unlock adalah DISPATCH
 * perintah ke broker, bukan perubahan state DB. Bila publisher melempar
 * (dispatch ke broker gagal), itu error sisi-server yang layak disurface:
 * kembalikan `502 Bad Gateway`. Keputusan ini sengaja sederhana; kita tidak
 * melaporkan hasil aktuasi relay, hanya keberhasilan pengiriman perintah.
 *
 * Desain dapat-diuji (injectable): factory `createDevicesRouter({ db, publisher,
 * offlineIntervalMs })` menerima `db` (default instance bersama getDb()),
 * `publisher` (biasanya instance mqttService) dengan method
 * `publishUnlock(deviceId, { nonce })`, dan `offlineIntervalMs` (ambang offline,
 * default 90 detik). Router ini TIDAK memasang middleware apiKey sendiri;
 * proteksi dipasang saat mounting (task 18).
 *
 * _Requirements: 11.2, 11.3, 11.4, 12.1, 12.2_
 */

const crypto = require('crypto');
const express = require('express');
const { getDb } = require('../db');
const deviceHealth = require('../services/deviceHealth');

/** Ambang offline default bila tidak dikonfigurasi: 90 detik (dalam ms). */
const DEFAULT_OFFLINE_INTERVAL_MS = 90 * 1000;

/** Panjang nonce (byte) untuk challenge unlock; 16 byte → 32 hex char. */
const NONCE_BYTES = 16;

/**
 * Bangkitkan nonce acak kriptografis sebagai hex string.
 * Dipakai untuk mengurangi replay pada perintah unlock (design.md Keamanan).
 * @returns {string} nonce hex (NONCE_BYTES * 2 karakter).
 */
function generateNonce() {
  return crypto.randomBytes(NONCE_BYTES).toString('hex');
}

/**
 * Bentuk ringkasan kesehatan sebuah baris device untuk respons dashboard.
 * Menghitung status ONLINE/OFFLINE dari last_seen vs now & ambang (Req 11.2/11.4)
 * dan mengekspos telemetri RSSI, fs_free, db_version (Req 11.3).
 * @param {object} row baris tabel devices.
 * @param {number} now waktu acuan (epoch ms).
 * @param {number} intervalMs ambang offline (ms).
 * @returns {object} ringkasan kesehatan device.
 */
function toHealth(row, now, intervalMs) {
  return {
    device_id: row.device_id,
    room_id: row.room_id,
    status: deviceHealth.status(row.last_seen, now, intervalMs),
    last_seen: row.last_seen,
    rssi: row.rssi,
    fs_free: row.fs_free,
    db_version: row.db_version,
  };
}

/**
 * Factory Router Express untuk device health & remote unlock.
 *
 * @param {object} [deps]
 * @param {import('better-sqlite3').Database} [deps.db]  instance DB (default getDb()).
 * @param {object} [deps.publisher]  publisher MQTT (mis. instance mqttService)
 *   dengan method `publishUnlock(deviceId, { nonce })`. Opsional untuk GET; wajib
 *   agar POST /unlock dapat mengirim perintah.
 * @param {number} [deps.offlineIntervalMs]  ambang offline dalam ms
 *   (default 90_000).
 * @returns {import('express').Router}
 */
function createDevicesRouter(deps = {}) {
  const {
    db = getDb(),
    publisher = null,
    offlineIntervalMs = DEFAULT_OFFLINE_INTERVAL_MS,
  } = deps;

  const router = express.Router();

  const selectAll = db.prepare(
    `SELECT device_id, room_id, last_seen, rssi, fs_free, db_version
       FROM devices
      ORDER BY device_id`
  );
  const selectOne = db.prepare(
    `SELECT device_id, room_id, last_seen, rssi, fs_free, db_version
       FROM devices
      WHERE device_id = ?`
  );

  /**
   * GET /api/devices
   * Daftar seluruh device dengan status ONLINE/OFFLINE + telemetri (Req 11.2/11.3/11.4).
   */
  router.get('/api/devices', (_req, res) => {
    const now = Date.now();
    const rows = selectAll.all();
    const devices = rows.map((row) => toHealth(row, now, offlineIntervalMs));
    res.status(200).json(devices);
  });

  /**
   * GET /api/devices/:dev
   * Kesehatan satu device; 404 bila tidak ditemukan (Req 11.2/11.3/11.4).
   */
  router.get('/api/devices/:dev', (req, res) => {
    const { dev } = req.params;
    const row = selectOne.get(dev);
    if (!row) {
      res.status(404).json({
        error: 'not_found',
        message: `Device '${dev}' tidak ditemukan`,
      });
      return;
    }
    res.status(200).json(toHealth(row, Date.now(), offlineIntervalMs));
  });

  /**
   * POST /api/devices/:dev/unlock
   * Remote unlock: bangkitkan nonce, publish `cmd/unlock` via MQTT (Req 12.1/12.2).
   *   - 404 bila device tidak ada.
   *   - 502 bila dispatch perintah ke broker gagal (publisher melempar).
   *   - 200 pada sukses dengan nonce & topik yang diterbitkan.
   */
  router.post('/api/devices/:dev/unlock', (req, res) => {
    const { dev } = req.params;

    const row = selectOne.get(dev);
    if (!row) {
      res.status(404).json({
        error: 'not_found',
        message: `Device '${dev}' tidak ditemukan`,
      });
      return;
    }

    if (!publisher || typeof publisher.publishUnlock !== 'function') {
      // Tanpa publisher, perintah tak dapat dikirim ke broker.
      res.status(502).json({
        error: 'publish_failed',
        message: 'Publisher MQTT tidak tersedia; perintah unlock tidak dapat dikirim',
      });
      return;
    }

    const nonce = generateNonce();
    let topic;
    try {
      topic = publisher.publishUnlock(dev, { nonce });
    } catch (err) {
      // Dispatch ke broker gagal → error sisi-server (Req 12.4 hanya melepaskan
      // kewajiban melaporkan hasil AKTUASI relay, bukan kegagalan dispatch).
      res.status(502).json({
        error: 'publish_failed',
        message: 'Gagal mengirim perintah unlock ke broker MQTT',
      });
      return;
    }

    res.status(200).json({
      device_id: dev,
      nonce,
      topic: topic || null,
      dispatched: true,
    });
  });

  return router;
}

module.exports = {
  createDevicesRouter,
  // Diekspos untuk pemakaian ulang/uji.
  generateNonce,
  toHealth,
  DEFAULT_OFFLINE_INTERVAL_MS,
};
