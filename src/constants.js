'use strict';

/**
 * Konstanta & util bersama — Smart Door KOS ESP32 (Web Server Node.js).
 *
 * Berisi nilai bersama yang dipakai lintas modul server (routes, services,
 * middleware) dan menjadi referensi portabel untuk lapisan firmware:
 *   - Status kartu (CARD_STATUS)
 *   - Nilai sync_type log akses (SYNC_TYPE)
 *   - Nama/template topik MQTT (MQTT base topic + subtopik per device)
 *
 * _Requirements: 7.1, 7.2, 19.1_
 */

/**
 * Status kartu NFC. Lihat Data Models (cards.status) di design.md.
 *   ACTIVE        — kartu valid & aktif, dapat GRANT.
 *   SUSPENDED     — ditangguhkan (mis. billing-lock: now >= expired_at).
 *   REVOKED       — dicabut permanen; dihapus dari whitelist firmware.
 *   UNPROVISIONED — provisioning gagal / belum selesai ditulis ke kartu.
 * @readonly
 */
const CARD_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  REVOKED: 'REVOKED',
  UNPROVISIONED: 'UNPROVISIONED',
});

/** Daftar seluruh nilai status kartu yang valid. */
const CARD_STATUS_VALUES = Object.freeze(Object.values(CARD_STATUS));

/**
 * Nilai sync_type pada access_logs. Lihat Req 15.
 *   REALTIME       — log diterima via jalur live (MQTT) saat perangkat online.
 *   CACHED_OFFLINE — log diterima dari antrean offline saat sinkronisasi.
 * @readonly
 */
const SYNC_TYPE = Object.freeze({
  REALTIME: 'REALTIME',
  CACHED_OFFLINE: 'CACHED_OFFLINE',
});

/** Daftar seluruh nilai sync_type yang valid. */
const SYNC_TYPE_VALUES = Object.freeze(Object.values(SYNC_TYPE));

/**
 * Base topic MQTT. Lihat "Desain Topik MQTT" di design.md.
 * Struktur: `smartdoor/{dev}/<subtopik>`.
 */
const MQTT_BASE_TOPIC = 'smartdoor';

/**
 * Subtopik MQTT per device (relatif terhadap `smartdoor/{dev}`).
 * Arah Firmware→Server: heartbeat, log, event/*.
 * Arah Server→Firmware: cmd/*.
 * @readonly
 */
const MQTT_SUBTOPIC = Object.freeze({
  // Firmware -> Server
  HEARTBEAT: 'heartbeat', // { rssi, fs_free, db_version, ts, api_key }  (Req 11.1)
  LOG: 'log', // { uid, result, ts, sync_type, api_key }       (Req 14)
  EVENT_TAMPER: 'event/tamper', // { ts, api_key }                       (Req 13.2)
  EVENT_BRUTEFORCE: 'event/bruteforce', // { count, ts, api_key }        (Req 13.1)
  // Server -> Firmware
  CMD_UNLOCK: 'cmd/unlock', // { nonce, api_key }                        (Req 12.2)
  CMD_REVOKE: 'cmd/revoke', // { uid, api_key }                          (Req 10.1)
  CMD_SUSPEND: 'cmd/suspend', // { uid, api_key }                        (Req 9.2)
  CMD_CONFIG: 'cmd/config', // { lock_open_duration_s, door_ajar_timeout_s, api_key } (Req 17.3)
  CMD_OTA: 'cmd/ota', // { url, checksum, api_key }                      (Req 16.2)
});

/**
 * Bentuk topik MQTT penuh untuk sebuah device dan subtopik.
 * @param {string} deviceId  id device (satu ESP32 per pintu).
 * @param {string} subtopic  subtopik relatif, mis. 'heartbeat' atau 'cmd/unlock'.
 * @returns {string} topik penuh, mis. 'smartdoor/dev01/heartbeat'.
 */
function deviceTopic(deviceId, subtopic) {
  if (!deviceId) {
    throw new Error('deviceTopic: deviceId wajib diisi');
  }
  if (!subtopic) {
    throw new Error('deviceTopic: subtopic wajib diisi');
  }
  return `${MQTT_BASE_TOPIC}/${deviceId}/${subtopic}`;
}

/**
 * Pola wildcard untuk subscribe semua topik milik sebuah device.
 * @param {string} deviceId id device.
 * @returns {string} mis. 'smartdoor/dev01/#'.
 */
function deviceTopicWildcard(deviceId) {
  if (!deviceId) {
    throw new Error('deviceTopicWildcard: deviceId wajib diisi');
  }
  return `${MQTT_BASE_TOPIC}/${deviceId}/#`;
}

/** Nama header HTTP untuk API_Key (Req 7.3/7.4). */
const API_KEY_HEADER = 'x-api-key';

module.exports = {
  CARD_STATUS,
  CARD_STATUS_VALUES,
  SYNC_TYPE,
  SYNC_TYPE_VALUES,
  MQTT_BASE_TOPIC,
  MQTT_SUBTOPIC,
  deviceTopic,
  deviceTopicWildcard,
  API_KEY_HEADER,
};
