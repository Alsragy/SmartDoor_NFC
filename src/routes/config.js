'use strict';

/**
 * Konfigurasi Parameter Pintu — route REST (Smart Door KOS ESP32).
 *
 * Mengimplementasikan design.md "Konfigurasi pintu (Req 17)" dan baris
 * "Desain Topik MQTT":
 *
 *   Server→Firmware | smartdoor/{dev}/cmd/config
 *     { lock_open_duration_s, door_ajar_timeout_s, api_key } | 17.3
 *
 * Tanggung jawab (task 17.3, Req 17.1/17.2/17.3):
 *   - `PUT /api/devices/:dev/config` body { lock_open_duration_s, door_ajar_timeout_s }:
 *       1. Validasi kedua nilai adalah bilangan bulat positif (> 0); bila tidak,
 *          respons 400 (selaras CHECK devices.lock_open_duration_s > 0 dan
 *          door_ajar_timeout_s > 0 pada schema.sql).
 *       2. 404 bila device tidak ditemukan.
 *       3. Simpan nilai ke baris `devices` (kolom lock_open_duration_s &
 *          door_ajar_timeout_s), perbarui updated_at — ini adalah desired config
 *          dan source of truth server (Req 17.1/17.2).
 *       4. Publish `cmd/config` { lock_open_duration_s, door_ajar_timeout_s } ke
 *          firmware device via `publisher.publishConfig(deviceId, {...})` (Req 17.3).
 *       5. Respons 200 dengan konfigurasi tersimpan.
 *
 * Kebijakan ketahanan publish (pola Req 9.4 yang sudah dipakai di revoke.js &
 * billingScheduler): KEGAGALAN PUBLISH TIDAK ME-ROLLBACK konfigurasi tersimpan.
 * Server menyimpan *desired config* sebagai source of truth; bila publish gagal,
 * server tetap merespons sukses dan konfigurasi dapat dikirim ulang (re-push)
 * pada publish berikutnya yang sukses. Firmware menerima parameter terbaru saat
 * publish berikutnya berhasil. Error publish ditangkap dan dilaporkan pada field
 * `synced` (true/false) di respons, bukan sebagai kegagalan request — selaras
 * dengan pola revoke.
 *
 * Desain dapat-diuji (injectable): factory `createConfigRouter({ db, publisher })`
 * menerima `db` (default instance bersama getDb()) dan `publisher` (biasanya
 * instance mqttService). Router ini TIDAK memasang middleware apiKey sendiri;
 * proteksi dipasang saat mounting (task 18).
 *
 * _Requirements: 17.1, 17.2, 17.3_
 */

const express = require('express');
const { getDb } = require('../db');

/**
 * Validasi sebuah nilai sebagai bilangan bulat positif (> 0).
 * Menolak non-number, NaN, Infinity, non-integer, dan nilai <= 0. Nilai yang
 * dikirim sebagai string numerik TIDAK diterima agar kontrak JSON tetap ketat.
 * @param {*} value nilai mentah dari body.
 * @returns {boolean} true iff `value` adalah integer > 0.
 */
function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Ambil baris device beserta konfigurasi pintunya.
 * @param {import('better-sqlite3').Database} db
 * @param {string} deviceId id device.
 * @returns {{device_id:string, lock_open_duration_s:number, door_ajar_timeout_s:number}|undefined}
 */
function selectDeviceConfig(db, deviceId) {
  return db
    .prepare(
      `SELECT device_id            AS device_id,
              lock_open_duration_s AS lock_open_duration_s,
              door_ajar_timeout_s  AS door_ajar_timeout_s
         FROM devices
        WHERE device_id = @device_id`
    )
    .get({ device_id: deviceId });
}

/**
 * Simpan konfigurasi pintu ke baris device (atomik, tanpa publish).
 * @param {import('better-sqlite3').Database} db
 * @param {string} deviceId id device.
 * @param {{lock_open_duration_s:number, door_ajar_timeout_s:number}} config
 */
function applyConfig(db, deviceId, config) {
  db.prepare(
    `UPDATE devices
        SET lock_open_duration_s = @lock_open_duration_s,
            door_ajar_timeout_s  = @door_ajar_timeout_s,
            updated_at           = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE device_id = @device_id`
  ).run({
    device_id: deviceId,
    lock_open_duration_s: config.lock_open_duration_s,
    door_ajar_timeout_s: config.door_ajar_timeout_s,
  });
}

/**
 * Publish `cmd/config` untuk sebuah device ke firmware-nya.
 *
 * Mendukung beberapa bentuk publisher yang dapat di-inject (selaras dengan pola
 * publishRevoke pada revoke.js):
 *   - `publisher.publishConfig(deviceId, { lock_open_duration_s, door_ajar_timeout_s })`
 *     (disarankan, sesuai mqttService)
 *   - `publisher.publish(topic, payload)` (fallback generik)
 *
 * @param {{publishConfig?:Function, publish?:Function}} publisher
 * @param {string} deviceId
 * @param {{lock_open_duration_s:number, door_ajar_timeout_s:number}} config
 */
function publishConfig(publisher, deviceId, config) {
  if (publisher && typeof publisher.publishConfig === 'function') {
    publisher.publishConfig(deviceId, config);
    return;
  }
  if (publisher && typeof publisher.publish === 'function') {
    publisher.publish(`smartdoor/${deviceId}/cmd/config`, config);
    return;
  }
  throw new TypeError(
    'publishConfig: publisher harus menyediakan publishConfig(deviceId, config) atau publish(topic, payload)'
  );
}

/**
 * Factory Router Express untuk konfigurasi parameter pintu.
 *
 * @param {object} [deps]
 * @param {import('better-sqlite3').Database} [deps.db]  instance DB (default getDb()).
 * @param {object} [deps.publisher]  publisher MQTT (mis. instance mqttService)
 *   dengan method `publishConfig(deviceId, { lock_open_duration_s, door_ajar_timeout_s })`.
 *   Opsional: bila absen, publish dilewati (config tetap tersimpan di DB).
 * @returns {import('express').Router}
 */
function createConfigRouter(deps = {}) {
  const { db = getDb(), publisher = null } = deps;
  const router = express.Router();

  /**
   * PUT /api/devices/:dev/config
   * Simpan parameter pintu & kirim ke firmware (Req 17.1/17.2/17.3).
   */
  router.put('/api/devices/:dev/config', (req, res) => {
    const deviceId = req.params.dev;
    const body = (req && req.body) || {};
    const { lock_open_duration_s, door_ajar_timeout_s } = body;

    // 1) Validasi input: kedua nilai wajib integer positif (Req 17.1/17.2,
    //    selaras CHECK > 0 pada schema.sql).
    if (
      !isPositiveInteger(lock_open_duration_s) ||
      !isPositiveInteger(door_ajar_timeout_s)
    ) {
      res.status(400).json({
        error: 'invalid_config',
        message:
          'lock_open_duration_s dan door_ajar_timeout_s harus berupa bilangan bulat positif (> 0)',
      });
      return;
    }

    // 2) 404 bila device tidak ada.
    const existing = selectDeviceConfig(db, deviceId);
    if (!existing) {
      res.status(404).json({
        error: 'not_found',
        message: `Device dengan id '${deviceId}' tidak ditemukan`,
      });
      return;
    }

    const config = { lock_open_duration_s, door_ajar_timeout_s };

    // 3) Simpan desired config (source of truth server).
    applyConfig(db, deviceId, config);

    // 4) Publish best-effort ke firmware. Req 9.4-style: kegagalan publish
    //    TIDAK membatalkan config tersimpan; config dapat di-push ulang.
    let synced = false;
    if (publisher) {
      try {
        publishConfig(publisher, deviceId, config);
        synced = true;
      } catch (err) {
        // Catat sebagai belum tersinkron; config DB tetap autoritatif.
        synced = false;
      }
    }

    // 5) Ambil state terbaru untuk respons.
    const saved = selectDeviceConfig(db, deviceId);

    res.status(200).json({
      device_id: saved.device_id,
      lock_open_duration_s: saved.lock_open_duration_s,
      door_ajar_timeout_s: saved.door_ajar_timeout_s,
      synced,
    });
  });

  return router;
}

module.exports = {
  createConfigRouter,
  // Diekspos untuk pemakaian ulang/uji.
  isPositiveInteger,
  selectDeviceConfig,
  applyConfig,
  publishConfig,
};
