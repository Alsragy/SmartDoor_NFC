'use strict';

/**
 * Klasifikasi kesehatan perangkat (online/offline) — Smart Door KOS ESP32.
 *
 * Modul MURNI (tanpa efek samping): tidak menyentuh I/O, jaringan, basis data,
 * maupun jam sistem. Semua input (`last_seen`, `now`, `interval`) diberikan
 * secara eksplisit sebagai argumen agar deterministik & mudah diuji
 * (property-based). `mqttService` yang mengonsumsi heartbeat menyimpan
 * `last_seen` per device; modul ini hanya mengklasifikasi status untuk
 * dashboard (Req 11.2, 11.4) tanpa melakukan I/O apa pun.
 *
 * Properti terkait (design.md):
 *   - Property 12: Klasifikasi status online/offline perangkat — perangkat
 *     ditandai Offline jika dan hanya jika `now - last_seen > interval`.
 *
 * _Requirements: 11.2, 11.4_
 */

/** Status kesehatan perangkat untuk dashboard. */
const DEVICE_STATUS = Object.freeze({
  ONLINE: 'ONLINE',
  OFFLINE: 'OFFLINE',
});

/**
 * Normalisasi sebuah nilai waktu ke milidetik epoch.
 * Menerima Date, number (epoch ms), atau string ISO-8601.
 * @param {Date|number|string} value
 * @returns {number} epoch ms, atau NaN jika tidak dapat diinterpretasikan.
 */
function toEpochMs(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return Date.parse(value);
  }
  return NaN;
}

/**
 * Tentukan apakah sebuah perangkat dianggap Offline pada waktu `now`.
 *
 * Perangkat Offline JIKA DAN HANYA JIKA `now - last_seen > interval`
 * (Property 12, Req 11.4). Artinya, selisih waktu yang **sama persis** dengan
 * `interval` (`now - last_seen === interval`) masih dianggap Online — ambang
 * bersifat ketat (strict greater-than).
 *
 * `interval` dinyatakan dalam **milidetik** (satuan sama dengan epoch ms hasil
 * normalisasi `last_seen`/`now`). Pemanggil wajib mengonversi interval
 * heartbeat terkonfigurasi (mis. detik) ke milidetik sebelum memanggil.
 *
 * Kasus khusus:
 *   - `last_seen` null/undefined (belum pernah terlihat) → Offline (true).
 *   - `now` atau `interval` tidak terbaca (NaN) → Offline (true), gagal-aman:
 *     perangkat yang tak dapat dipastikan Online ditandai Offline di dashboard.
 *   - `interval` negatif diperlakukan apa adanya terhadap selisih waktu.
 *
 * @param {Date|number|string|null|undefined} lastSeen  waktu heartbeat terakhir.
 * @param {Date|number|string} now        waktu acuan sekarang.
 * @param {number} interval                ambang dalam milidetik.
 * @returns {boolean} true iff perangkat Offline (`now - last_seen > interval`).
 */
function isOffline(lastSeen, now, interval) {
  // Belum pernah terlihat → Offline.
  if (lastSeen === null || lastSeen === undefined || lastSeen === '') {
    return true;
  }

  const lastSeenMs = toEpochMs(lastSeen);
  const nowMs = toEpochMs(now);

  // Waktu tak terbaca atau interval bukan angka berhingga → gagal-aman: Offline.
  if (
    Number.isNaN(lastSeenMs) ||
    Number.isNaN(nowMs) ||
    typeof interval !== 'number' ||
    !Number.isFinite(interval)
  ) {
    return true;
  }

  return nowMs - lastSeenMs > interval;
}

/**
 * Status kesehatan perangkat untuk ditampilkan di dashboard (Req 11.2).
 *
 * @param {Date|number|string|null|undefined} lastSeen  waktu heartbeat terakhir.
 * @param {Date|number|string} now        waktu acuan sekarang.
 * @param {number} interval                ambang dalam milidetik.
 * @returns {string} 'OFFLINE' iff `isOffline(...)`, selain itu 'ONLINE'.
 */
function status(lastSeen, now, interval) {
  return isOffline(lastSeen, now, interval)
    ? DEVICE_STATUS.OFFLINE
    : DEVICE_STATUS.ONLINE;
}

module.exports = {
  DEVICE_STATUS,
  isOffline,
  status,
};
