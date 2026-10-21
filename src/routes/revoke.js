'use strict';

/**
 * Pencabutan & Blacklist Instan — route REST (Smart Door KOS ESP32).
 *
 * Mengimplementasikan design.md "Pencabutan & Blacklist Instan (Req 10)":
 *
 *   A->>API: POST /api/cards/{uid}/revoke (API_Key)
 *   API->>DB: UPDATE cards status='REVOKED', naikkan db_version
 *   API->>MQ: publish smartdoor/{dev}/cmd/revoke {uid, API_Key}
 *   MQ->>F : perintah hapus-akses → firmware hapus uid dari whitelist LittleFS
 *
 * Tanggung jawab (task 14.2, Req 10.1):
 *   - `POST /api/cards/:uid/revoke`:
 *       1. 404 bila kartu tidak ditemukan.
 *       2. Set `cards.status = 'REVOKED'`, naikkan `cards.db_version`, dan
 *          naikkan `devices.db_version` pemilik kartu (bila ada) agar perubahan
 *          masuk ke delta-sync berikutnya (removal dari whitelist firmware;
 *          design.md "Versioning & Hash Kartu untuk Delta Sync", Req 4.3).
 *       3. Publish `cmd/revoke` { uid } ke firmware device terkait via
 *          `publisher.publishRevoke(deviceId, { uid })`.
 *       4. Respons 200 dengan state kartu terbaru.
 *
 * Device ditentukan via join cards→rooms→devices (satu kamar satu device,
 * lihat schema.sql). Bila kartu tidak terpasang device (device_id NULL),
 * revoke DB tetap diterapkan dan publish dilewati (tak ada tujuan firmware).
 *
 * Kebijakan ketahanan publish (pola Req 9.4 yang sudah dipakai di
 * billingScheduler): KEGAGALAN PUBLISH TIDAK ME-ROLLBACK revoke di DB.
 * Revoke di DB adalah source of truth server; bila publish gagal, server
 * tetap merespons sukses dan firmware akan menyusul lewat delta-sync
 * berikutnya (card.db_version > device.db_version memicu removal). Error
 * publish ditangkap dan dilaporkan pada field `synced` di respons, bukan
 * sebagai kegagalan request.
 *
 * Desain dapat-diuji (injectable): factory `createRevokeRouter({ db, publisher })`
 * menerima `db` (default instance bersama getDb()) dan `publisher` (biasanya
 * instance mqttService). Router ini TIDAK memasang middleware apiKey sendiri;
 * proteksi dipasang saat mounting (task 18).
 *
 * _Requirements: 10.1_
 */

const express = require('express');
const { CARD_STATUS } = require('../constants');
const { getDb } = require('../db');

/**
 * Ambil kartu beserta device pemiliknya via join cards→rooms→devices.
 * @param {import('better-sqlite3').Database} db
 * @param {string} uid uid kartu.
 * @returns {{uid:string, status:string, db_version:number, device_id:(string|null)}|undefined}
 */
function selectCardWithDevice(db, uid) {
  return db
    .prepare(
      `SELECT c.uid        AS uid,
              c.status     AS status,
              c.db_version AS db_version,
              d.device_id  AS device_id
         FROM cards c
         LEFT JOIN rooms   r ON r.id = c.room_id
         LEFT JOIN devices d ON d.device_id = r.device_id
        WHERE c.uid = @uid`
    )
    .get({ uid });
}

/**
 * Terapkan revoke pada satu kartu di DB (atomik, tanpa publish):
 *   - status = 'REVOKED'
 *   - db_version kartu +1
 *   - db_version device pemilik +1 (bila ada) untuk memicu delta-sync/removal
 *   - updated_at diperbarui
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} uid uid kartu.
 * @param {string|null} deviceId device pemilik (boleh null).
 */
function applyRevoke(db, uid, deviceId) {
  const run = db.transaction(() => {
    db.prepare(
      `UPDATE cards
          SET status     = @revoked,
              db_version = db_version + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE uid = @uid`
    ).run({ revoked: CARD_STATUS.REVOKED, uid });

    if (deviceId) {
      db.prepare(
        `UPDATE devices
            SET db_version = db_version + 1,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE device_id = @device_id`
      ).run({ device_id: deviceId });
    }
  });
  run();
}

/**
 * Publish `cmd/revoke` untuk sebuah kartu ke firmware device-nya.
 *
 * Mendukung beberapa bentuk publisher yang dapat di-inject agar fleksibel &
 * mudah diuji (selaras dengan pola publishSuspend di billingScheduler):
 *   - `publisher.publishRevoke(deviceId, { uid })` (disarankan, sesuai mqttService)
 *   - `publisher.publish(topic, payload)` (fallback generik)
 *
 * @param {{publishRevoke?:Function, publish?:Function}} publisher
 * @param {string} deviceId
 * @param {string} uid
 */
function publishRevoke(publisher, deviceId, uid) {
  if (publisher && typeof publisher.publishRevoke === 'function') {
    publisher.publishRevoke(deviceId, { uid });
    return;
  }
  if (publisher && typeof publisher.publish === 'function') {
    publisher.publish(`smartdoor/${deviceId}/cmd/revoke`, { uid });
    return;
  }
  throw new TypeError(
    'publishRevoke: publisher harus menyediakan publishRevoke(deviceId, { uid }) atau publish(topic, payload)'
  );
}

/**
 * Factory Router Express untuk pencabutan instan.
 *
 * @param {object} [deps]
 * @param {import('better-sqlite3').Database} [deps.db]  instance DB (default getDb()).
 * @param {object} [deps.publisher]  publisher MQTT (mis. instance mqttService)
 *   dengan method `publishRevoke(deviceId, { uid })`. Opsional: bila absen,
 *   publish dilewati (revoke DB tetap diterapkan).
 * @returns {import('express').Router}
 */
function createRevokeRouter(deps = {}) {
  const { db = getDb(), publisher = null } = deps;
  const router = express.Router();

  /**
   * POST /api/cards/:uid/revoke
   * Cabut akses kartu secara instan (Req 10.1).
   */
  router.post('/api/cards/:uid/revoke', (req, res) => {
    const { uid } = req.params;

    const card = selectCardWithDevice(db, uid);
    if (!card) {
      res.status(404).json({
        error: 'not_found',
        message: `Kartu dengan uid '${uid}' tidak ditemukan`,
      });
      return;
    }

    const deviceId = card.device_id || null;

    // 1) Revoke di DB (source of truth server) secara atomik.
    applyRevoke(db, uid, deviceId);

    // 2) Publish best-effort ke firmware. Req 9.4-style: kegagalan publish
    //    TIDAK membatalkan revoke DB; firmware menyusul via delta-sync.
    let synced = false;
    if (deviceId && publisher) {
      try {
        publishRevoke(publisher, deviceId, uid);
        synced = true;
      } catch (err) {
        // Catat sebagai belum tersinkron; revoke DB tetap autoritatif.
        synced = false;
      }
    }

    // 3) Ambil state terbaru untuk respons.
    const updated = selectCardWithDevice(db, uid);

    res.status(200).json({
      uid: updated.uid,
      status: updated.status,
      db_version: updated.db_version,
      device_id: deviceId,
      synced,
    });
  });

  return router;
}

module.exports = {
  createRevokeRouter,
  // Diekspos untuk pemakaian ulang/uji.
  selectCardWithDevice,
  applyRevoke,
  publishRevoke,
};
