'use strict';

/**
 * MQTT Service — Smart Door KOS ESP32 (Web Server Node.js).
 *
 * Jembatan real-time antara Web_Server dan Firmware ESP32 (satu ESP32 per
 * pintu) melalui MQTT_Broker. Mengikuti design.md "Desain Topik MQTT" &
 * "Autentikasi API_Key (Req 7)".
 *
 * Arah Firmware → Server (service berlangganan/subscribe, wildcard per device):
 *   - `smartdoor/+/heartbeat`         { rssi, fs_free, db_version, ts, api_key } (Req 11.1)
 *   - `smartdoor/+/log`               { uid, result, ts, sync_type, api_key }    (Req 14/15.2)
 *   - `smartdoor/+/event/tamper`      { ts, api_key }                            (Req 13.2)
 *   - `smartdoor/+/event/bruteforce`  { count, ts, api_key }                     (Req 13.1)
 *
 * Arah Server → Firmware (service mem-publish perintah, api_key disisipkan):
 *   - `smartdoor/{dev}/cmd/unlock`    { nonce, api_key }                         (Req 12.2)
 *   - `smartdoor/{dev}/cmd/revoke`    { uid, api_key }                           (Req 10.1)
 *   - `smartdoor/{dev}/cmd/suspend`   { uid, api_key }                           (Req 9.2)
 *   - `smartdoor/{dev}/cmd/config`    { lock_open_duration_s, door_ajar_timeout_s, api_key } (Req 17.3)
 *
 * Autentikasi per-payload (Req 7.3/7.4): SETIAP pesan masuk divalidasi memakai
 * `isValidApiKey(payload.api_key)`. Pesan/perintah tanpa API_Key valid DIABAIKAN
 * secara diam-diam (fail-closed) — tidak menyentuh basis data maupun live feed.
 *
 * Perutean konsumer:
 *   - heartbeat  → upsert kolom telemetri `devices` (last_seen/rssi/fs_free/db_version), Req 11.1.
 *   - log        → `auditTrail.recordLog(log, 'REALTIME', db)` + broadcast live feed, Req 14.1/15.2.
 *   - event/*    → tandai alert MERAH untuk device terkait + broadcast live feed, Req 13.1/13.2/13.3.
 *
 * Desain dapat-diuji (injectable): seluruh I/O broker berada di belakang klien
 * `mqtt` yang dapat diinjeksi, sehingga unit test dapat memasok klien palsu
 * berbasis EventEmitter tanpa broker nyata. `db`, `auditTrail`, dan `liveFeed`
 * juga dapat diinjeksi.
 *
 * _Requirements: 7.1, 7.3, 7.4, 9.2, 10.1, 11.1, 12.2, 13.1, 13.2, 13.3, 14.1, 15.2, 17.3_
 */

const {
  MQTT_BASE_TOPIC,
  MQTT_SUBTOPIC,
  SYNC_TYPE,
  deviceTopic,
} = require('../constants');
const { getDb } = require('../db');
const { isValidApiKey } = require('../middleware/apiKey');
const auditTrailDefault = require('./auditTrail');

/** Nama variabel environment yang menyimpan API_Key (dipakai saat publish). */
const API_KEY_ENV = 'SMARTDOOR_API_KEY';

/** Pola topik berlangganan (wildcard per-device `+` pada posisi {dev}). */
const SUBSCRIBE_TOPICS = Object.freeze([
  `${MQTT_BASE_TOPIC}/+/${MQTT_SUBTOPIC.HEARTBEAT}`,
  `${MQTT_BASE_TOPIC}/+/${MQTT_SUBTOPIC.LOG}`,
  `${MQTT_BASE_TOPIC}/+/${MQTT_SUBTOPIC.EVENT_TAMPER}`,
  `${MQTT_BASE_TOPIC}/+/${MQTT_SUBTOPIC.EVENT_BRUTEFORCE}`,
]);

/** SQL upsert telemetri heartbeat ke `devices` (Req 11.1). */
const HEARTBEAT_UPSERT_SQL = `
  INSERT INTO devices (device_id, last_seen, rssi, fs_free, db_version, updated_at)
  VALUES (@device_id, @last_seen, @rssi, @fs_free, @db_version,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(device_id) DO UPDATE SET
    last_seen  = excluded.last_seen,
    rssi       = excluded.rssi,
    fs_free    = excluded.fs_free,
    db_version = excluded.db_version,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
`;

/**
 * Ekstrak `device_id` dari sebuah topik `smartdoor/{dev}/<subtopik>`.
 * @param {string} topic topik penuh.
 * @returns {string|null} device id, atau null bila topik tidak valid.
 */
function parseDeviceId(topic) {
  if (typeof topic !== 'string') {
    return null;
  }
  const parts = topic.split('/');
  if (parts.length < 3 || parts[0] !== MQTT_BASE_TOPIC) {
    return null;
  }
  const dev = parts[1];
  return dev ? dev : null;
}

/**
 * Ekstrak subtopik relatif (tanpa `smartdoor/{dev}/`) dari topik penuh.
 * Mempertahankan segmen bersarang mis. `event/tamper`.
 * @param {string} topic topik penuh.
 * @returns {string|null} subtopik relatif, atau null bila topik tidak valid.
 */
function parseSubtopic(topic) {
  if (typeof topic !== 'string') {
    return null;
  }
  const parts = topic.split('/');
  if (parts.length < 3 || parts[0] !== MQTT_BASE_TOPIC) {
    return null;
  }
  return parts.slice(2).join('/');
}

/**
 * Parse payload mentah (Buffer/string/objek) menjadi objek JSON.
 * @param {Buffer|string|object} raw payload pesan.
 * @returns {object|null} objek hasil parse, atau null bila gagal/bukan objek.
 */
function parsePayload(raw) {
  try {
    if (raw == null) {
      return null;
    }
    if (typeof raw === 'object' && !Buffer.isBuffer(raw)) {
      return raw;
    }
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Normalisasi bilangan bulat opsional dari payload (untuk kolom INTEGER).
 * @param {*} value nilai mentah.
 * @returns {number|null} integer, atau null bila tak dapat dikonversi.
 */
function toIntOrNull(value) {
  if (value == null) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Factory layanan MQTT dengan dependensi yang dapat diinjeksi.
 *
 * @param {object} [deps]
 * @param {object} [deps.client]      klien MQTT siap pakai (hasil `mqtt.connect`
 *   atau palsu berbasis EventEmitter untuk uji). Jika absen, pakai `connect()`.
 * @param {Function} [deps.mqtt]      modul `mqtt` (default require('mqtt')); hanya
 *   dipakai bila `connect(brokerUrl)` dipanggil tanpa `client` injeksi.
 * @param {import('better-sqlite3').Database} [deps.db]  instance DB (default getDb()).
 * @param {object} [deps.auditTrail]  modul audit trail (default ./auditTrail).
 * @param {object} [deps.liveFeed]    hub live feed dengan method `broadcast(event)`
 *   dan/atau `alert(event)`. Opsional; bila absen, broadcast dilewati.
 * @param {NodeJS.ProcessEnv} [deps.env]  sumber konfigurasi API_Key (untuk uji).
 * @returns {object} instance layanan MQTT.
 */
function createMqttService(deps = {}) {
  const {
    db = getDb(),
    auditTrail = auditTrailDefault,
    liveFeed = null,
    env = process.env,
  } = deps;

  let client = deps.client || null;
  const mqttLib = deps.mqtt || null;

  /**
   * Broadcast sebuah event ke live feed bila hub tersedia (Req 14.1/13.3).
   * Toleran: memakai `alert()` untuk event berjenis alert bila ada, selain itu
   * `broadcast()`. Kegagalan hub tidak boleh menjatuhkan pemrosesan pesan.
   * @param {object} event payload event untuk dashboard.
   */
  function emitToFeed(event) {
    if (!liveFeed) {
      return;
    }
    try {
      if (event && event.alert && typeof liveFeed.alert === 'function') {
        liveFeed.alert(event);
        return;
      }
      if (typeof liveFeed.broadcast === 'function') {
        liveFeed.broadcast(event);
      }
    } catch {
      // Live feed bersifat best-effort; abaikan kegagalan broadcast.
    }
  }

  /**
   * Konsumer heartbeat: upsert telemetri device (Req 11.1).
   * @param {string} deviceId
   * @param {object} payload { rssi, fs_free, db_version, ts, api_key }
   */
  function handleHeartbeat(deviceId, payload) {
    const row = {
      device_id: deviceId,
      last_seen: payload.ts != null ? String(payload.ts) : null,
      rssi: toIntOrNull(payload.rssi),
      fs_free: toIntOrNull(payload.fs_free),
      db_version: toIntOrNull(payload.db_version) || 0,
    };
    db.prepare(HEARTBEAT_UPSERT_SQL).run(row);
    emitToFeed({ type: 'heartbeat', device_id: deviceId, ...row });
  }

  /**
   * Konsumer log: simpan ke access_logs sebagai REALTIME + broadcast (Req 14.1/15.2).
   * @param {string} deviceId
   * @param {object} payload objek log { uid, result, ts, ... , api_key }
   */
  function handleLog(deviceId, payload) {
    // Pastikan device_id kanonik dari topik (bukan klaim payload).
    const log = { ...payload, device_id: deviceId };
    const result = auditTrail.recordLog(log, SYNC_TYPE.REALTIME, db);
    emitToFeed({
      type: 'log',
      device_id: deviceId,
      sync_type: SYNC_TYPE.REALTIME,
      log,
      accepted: result.accepted,
    });
  }

  /**
   * Konsumer event keamanan: tandai alert MERAH untuk device (Req 13.1/13.2/13.3).
   * @param {string} deviceId
   * @param {'tamper'|'bruteforce'} kind jenis event.
   * @param {object} payload { ts, api_key, [count] }
   */
  function handleSecurityEvent(deviceId, kind, payload) {
    emitToFeed({
      type: 'event',
      event: kind,
      device_id: deviceId,
      alert: 'red',
      count: kind === 'bruteforce' ? toIntOrNull(payload.count) : undefined,
      ts: payload.ts != null ? String(payload.ts) : undefined,
    });
  }

  /**
   * Handler pesan MQTT terpusat: parse → validasi api_key → rute berdasarkan topik.
   * Pesan tanpa API_Key valid DIABAIKAN (Req 7.3/7.4, fail-closed).
   *
   * @param {string} topic topik pesan.
   * @param {Buffer|string|object} raw payload pesan.
   */
  function onMessage(topic, raw) {
    const deviceId = parseDeviceId(topic);
    const subtopic = parseSubtopic(topic);
    if (!deviceId || !subtopic) {
      return;
    }

    const payload = parsePayload(raw);
    if (!payload) {
      return;
    }

    // Validasi API_Key per-payload (Req 7.3/7.4). Abaikan bila tidak valid.
    if (!isValidApiKey(payload.api_key, env)) {
      return;
    }

    switch (subtopic) {
      case MQTT_SUBTOPIC.HEARTBEAT:
        handleHeartbeat(deviceId, payload);
        break;
      case MQTT_SUBTOPIC.LOG:
        handleLog(deviceId, payload);
        break;
      case MQTT_SUBTOPIC.EVENT_TAMPER:
        handleSecurityEvent(deviceId, 'tamper', payload);
        break;
      case MQTT_SUBTOPIC.EVENT_BRUTEFORCE:
        handleSecurityEvent(deviceId, 'bruteforce', payload);
        break;
      default:
        // Subtopik di luar kontrak konsumer diabaikan.
        break;
    }
  }

  /**
   * Pasang listener & berlangganan topik pada klien saat tersambung.
   * Dipanggil otomatis oleh `connect()`; dipisah agar dapat dipakai ulang
   * ketika klien diinjeksi langsung.
   */
  function attach() {
    if (!client) {
      throw new Error('mqttService: klien MQTT belum tersedia');
    }
    // Berlangganan saat koneksi terbentuk. Untuk klien palsu yang sudah
    // "tersambung", event 'connect' dapat di-emit manual oleh pemanggil/uji.
    client.on('connect', () => {
      client.subscribe(SUBSCRIBE_TOPICS, { qos: 1 }, () => {});
    });
    client.on('message', onMessage);
  }

  /**
   * Bangun koneksi ke broker lalu berlangganan topik konsumer.
   * Bila klien telah diinjeksi (deps.client), gunakan apa adanya dan cukup
   * pasang listener; jika tidak, panggil `mqtt.connect(brokerUrl, options)`.
   *
   * @param {string} [brokerUrl] URL broker (mis. 'mqtt://localhost:1883').
   * @param {object} [options] opsi koneksi mqtt.
   * @returns {object} klien MQTT yang dipakai.
   */
  function connect(brokerUrl, options = {}) {
    if (!client) {
      const lib = mqttLib || require('mqtt');
      client = lib.connect(brokerUrl, options);
    }
    attach();
    return client;
  }

  /**
   * Ambil API_Key terkonfigurasi untuk disisipkan pada payload perintah.
   * @returns {string} API_Key, atau string kosong bila belum dikonfigurasi.
   * @throws {Error} bila API_Key belum dikonfigurasi (fail-closed) — perintah
   *   tanpa API_Key valid akan diabaikan firmware, jadi publish tanpa kunci
   *   adalah bug konfigurasi yang harus terlihat.
   */
  function requireApiKey() {
    const key = env[API_KEY_ENV];
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(
        'mqttService: SMARTDOOR_API_KEY belum dikonfigurasi; perintah tidak dapat diautentikasi'
      );
    }
    return key;
  }

  /**
   * Publish sebuah perintah ke topik cmd device dengan api_key tersisip.
   * @param {string} deviceId  id device tujuan.
   * @param {string} subtopic  subtopik cmd (mis. MQTT_SUBTOPIC.CMD_UNLOCK).
   * @param {object} body      field-field perintah (tanpa api_key).
   * @returns {string} topik yang dipublikasikan (berguna untuk uji/logging).
   */
  function publishCommand(deviceId, subtopic, body) {
    if (!client) {
      throw new Error('mqttService: belum tersambung; panggil connect() dulu');
    }
    const topic = deviceTopic(deviceId, subtopic);
    const payload = { ...body, api_key: requireApiKey() };
    client.publish(topic, JSON.stringify(payload), { qos: 1 });
    return topic;
  }

  /**
   * Remote unlock (Req 12.2): publish `cmd/unlock` { nonce, api_key }.
   * @param {string} deviceId
   * @param {{ nonce: string }} params nonce challenge.
   * @returns {string} topik yang dipublikasikan.
   */
  function publishUnlock(deviceId, { nonce } = {}) {
    return publishCommand(deviceId, MQTT_SUBTOPIC.CMD_UNLOCK, { nonce });
  }

  /**
   * Pencabutan instan (Req 10.1): publish `cmd/revoke` { uid, api_key }.
   * @param {string} deviceId
   * @param {{ uid: string }} params uid kartu yang dicabut.
   * @returns {string} topik yang dipublikasikan.
   */
  function publishRevoke(deviceId, { uid } = {}) {
    return publishCommand(deviceId, MQTT_SUBTOPIC.CMD_REVOKE, { uid });
  }

  /**
   * Billing-lock/suspend (Req 9.2): publish `cmd/suspend` { uid, api_key }.
   * @param {string} deviceId
   * @param {{ uid: string }} params uid kartu yang ditangguhkan.
   * @returns {string} topik yang dipublikasikan.
   */
  function publishSuspend(deviceId, { uid } = {}) {
    return publishCommand(deviceId, MQTT_SUBTOPIC.CMD_SUSPEND, { uid });
  }

  /**
   * Konfigurasi pintu (Req 17.3): publish `cmd/config`
   * { lock_open_duration_s, door_ajar_timeout_s, api_key }.
   * @param {string} deviceId
   * @param {{ lock_open_duration_s: number, door_ajar_timeout_s: number }} params
   * @returns {string} topik yang dipublikasikan.
   */
  function publishConfig(deviceId, { lock_open_duration_s, door_ajar_timeout_s } = {}) {
    return publishCommand(deviceId, MQTT_SUBTOPIC.CMD_CONFIG, {
      lock_open_duration_s,
      door_ajar_timeout_s,
    });
  }

  /**
   * Notifikasi OTA tersedia (Req 16.2): publish `cmd/ota`
   * { url, checksum, api_key }. Firmware menarik `.bin` dari `url` dengan
   * API_Key lalu memverifikasi `checksum` sebelum menerapkan (Req 16.3).
   * @param {string} deviceId
   * @param {{ url: string, checksum: string }} params URL unduh & checksum SHA-256.
   * @returns {string} topik yang dipublikasikan.
   */
  function publishOta(deviceId, { url, checksum } = {}) {
    return publishCommand(deviceId, MQTT_SUBTOPIC.CMD_OTA, { url, checksum });
  }

  /**
   * Tutup koneksi broker (teardown).
   * @param {boolean} [force] paksa tutup tanpa menunggu pesan tertunda.
   */
  function end(force = false) {
    if (client && typeof client.end === 'function') {
      client.end(force);
    }
  }

  return {
    connect,
    end,
    // Konsumer / handler (diekspos untuk uji & pemakaian lanjutan).
    onMessage,
    // Publisher perintah.
    publishUnlock,
    publishRevoke,
    publishSuspend,
    publishConfig,
    publishOta,
    publishCommand,
    // Akses klien aktif (mis. untuk uji).
    get client() {
      return client;
    },
    // Konstanta yang berguna untuk uji.
    SUBSCRIBE_TOPICS,
  };
}

module.exports = {
  createMqttService,
  // Util diekspos untuk pemakaian ulang/uji.
  parseDeviceId,
  parseSubtopic,
  parsePayload,
  SUBSCRIBE_TOPICS,
  API_KEY_ENV,
};
