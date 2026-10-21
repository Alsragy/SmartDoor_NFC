'use strict';

/**
 * Billing-Lock Scheduler — Smart Door KOS ESP32 (Web Server Node.js).
 *
 * Tanggung jawab (task 14.1, Req 9):
 *   - Job periodik memindai tabel `cards` yang sudah kedaluwarsa
 *     (`expired_at IS NOT NULL AND expired_at <= now`) dan belum berstatus
 *     terminal (`status NOT IN ('SUSPENDED','REVOKED')`), lalu:
 *       1. UPDATE `status = 'SUSPENDED'` pada kartu tersebut (Req 9.2).
 *       2. Naikkan `db_version` kartu DAN `db_version` device pemilik kartu
 *          agar perubahan masuk ke delta-sync berikutnya (Req 4.3 / whitelist).
 *       3. Publish perintah `cmd/suspend` ke firmware device terkait via MQTT
 *          publisher yang di-inject (Req 9.2).
 *   - Mengembalikan ringkasan hasil ({ suspended, count, syncFailed, ... }).
 *
 * Pemisahan transport/domain (design.md "Pemisahan Tanggung Jawab"):
 *   - Logika inti ada di `runBillingLock(now, { db, publisher })` yang bersifat
 *     "pure-ish": seluruh dependensi (DB & MQTT publisher) di-inject sehingga
 *     dapat diuji unit/property tanpa broker nyata maupun jam sistem.
 *   - `start()`/`stop()` hanya membungkus pemanggilan periodik via setInterval
 *     dan sengaja dibuat tipis.
 *
 * Kebijakan kegagalan sinkronisasi (Req 9.4 — penting):
 *   JIKA sinkronisasi status Suspended ke firmware GAGAL atau belum terjadi
 *   (publisher melempar error / belum terkirim), kartu tetap aktif secara
 *   FUNGSIONAL di tingkat firmware hingga sinkronisasi berhasil, dan server
 *   HARUS mencoba ulang di kemudian waktu. Implikasi implementasi:
 *     - Kegagalan publish TIDAK boleh me-rollback suspend di DB. Suspend di DB
 *       (source of truth server) tetap diterapkan; kita hanya menandai bahwa
 *       kartu tsb. belum tersinkron ke firmware.
 *     - Error publish ditangkap (catch) per-kartu; run tidak boleh crash.
 *     - Retry terjadi secara alami: `runBillingLock` memilih kartu yang masih
 *       memerlukan sinkronisasi — yakni selain kartu yang baru saja di-suspend,
 *       juga kartu yang SUDAH SUSPENDED namun db_version kartunya masih lebih
 *       baru daripada db_version device (artinya suspend belum tersinkron).
 *       Dengan begitu run berikutnya akan mem-publish ulang `cmd/suspend` untuk
 *       kartu yang publish-nya gagal sebelumnya, tanpa perlu kolom skema baru.
 *
 * _Requirements: 9.1, 9.2, 9.3, 9.4_
 */

const { CARD_STATUS, MQTT_SUBTOPIC } = require('../constants');

/**
 * Interval default pemindaian billing-lock (milidetik). Design menyarankan
 * "tiap menit"; dibuat dapat dioverride lewat opsi `start({ intervalMs })`.
 */
const DEFAULT_INTERVAL_MS = 60 * 1000;

/**
 * Normalisasi `now` ke string ISO-8601 UTC agar perbandingan terhadap kolom
 * `cards.expired_at` (disimpan sebagai TEXT ISO-8601, lihat schema.sql)
 * dilakukan secara leksikografis yang konsisten.
 * Menerima Date, number (epoch ms), atau string (diasumsikan sudah ISO-8601).
 * @param {Date|number|string} now
 * @returns {string} representasi ISO-8601 UTC dari `now`.
 */
function toIso(now) {
  if (now instanceof Date) {
    return now.toISOString();
  }
  if (typeof now === 'number') {
    return new Date(now).toISOString();
  }
  if (typeof now === 'string') {
    // String diasumsikan sudah ISO-8601 UTC (konsisten dengan penyimpanan).
    return now;
  }
  throw new TypeError('runBillingLock: now harus Date, number (epoch ms), atau string ISO-8601');
}

/**
 * Query kandidat kartu yang perlu diproses billing-lock pada waktu `now`.
 *
 * Dua kelompok kandidat (lihat kebijakan Req 9.4 di header modul):
 *   (A) Kartu kedaluwarsa yang BELUM di-suspend:
 *         expired_at IS NOT NULL AND expired_at <= now
 *         AND status NOT IN ('SUSPENDED','REVOKED')
 *       → akan di-suspend + db_version naik + publish.
 *   (B) Kartu yang SUDAH 'SUSPENDED' namun suspend-nya belum tersinkron ke
 *       firmware (card.db_version > device.db_version) → hanya perlu
 *       publish ulang (retry), TANPA mengubah db_version lagi.
 *
 * Kolom `device_id` diperoleh via join cards→rooms→devices (satu kamar satu
 * device, lihat schema.sql). Kartu tanpa device terpasang (device_id NULL)
 * tetap dikembalikan untuk kelompok (A) agar tetap di-suspend di DB; publish
 * untuk kartu seperti itu dilewati (tak ada tujuan firmware).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} nowIso waktu acuan ISO-8601.
 * @returns {Array<{uid:string, status:string, card_db_version:number, device_id:(string|null), device_db_version:(number|null)}>}
 */
function selectCandidates(db, nowIso) {
  const stmt = db.prepare(
    `SELECT c.uid                 AS uid,
            c.status              AS status,
            c.db_version          AS card_db_version,
            d.device_id           AS device_id,
            d.db_version          AS device_db_version
       FROM cards c
       LEFT JOIN rooms   r ON r.id = c.room_id
       LEFT JOIN devices d ON d.device_id = r.device_id
      WHERE (
              c.expired_at IS NOT NULL
              AND c.expired_at <= @now
              AND c.status NOT IN (@suspended, @revoked)
            )
         OR (
              c.status = @suspended
              AND d.device_id IS NOT NULL
              AND c.db_version > d.db_version
            )`
  );
  return stmt.all({
    now: nowIso,
    suspended: CARD_STATUS.SUSPENDED,
    revoked: CARD_STATUS.REVOKED,
  });
}

/**
 * Terapkan suspend pada satu kartu di DB (tanpa publish):
 *   - status = 'SUSPENDED'
 *   - db_version kartu +1
 *   - db_version device pemilik +1 (bila ada) untuk memicu delta-sync
 *   - updated_at diperbarui
 *
 * Dipanggil hanya untuk kandidat kelompok (A). Harus berjalan di dalam
 * transaksi (lihat `runBillingLock`).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{uid:string, device_id:(string|null)}} candidate
 */
function applySuspend(db, candidate) {
  db.prepare(
    `UPDATE cards
        SET status     = @suspended,
            db_version = db_version + 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE uid = @uid`
  ).run({ suspended: CARD_STATUS.SUSPENDED, uid: candidate.uid });

  if (candidate.device_id) {
    db.prepare(
      `UPDATE devices
          SET db_version = db_version + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE device_id = @device_id`
    ).run({ device_id: candidate.device_id });
  }
}

/**
 * Publish perintah `cmd/suspend` untuk sebuah kartu ke firmware device-nya.
 *
 * Mendukung beberapa bentuk publisher yang dapat di-inject agar fleksibel &
 * mudah diuji:
 *   - `publisher.publishSuspend(deviceId, uid)` (disarankan, sesuai mqttService)
 *   - `publisher.publish(topic, payload)` (fallback generik)
 *
 * @param {{publishSuspend?:Function, publish?:Function}} publisher
 * @param {string} deviceId
 * @param {string} uid
 */
function publishSuspend(publisher, deviceId, uid) {
  if (publisher && typeof publisher.publishSuspend === 'function') {
    publisher.publishSuspend(deviceId, uid);
    return;
  }
  if (publisher && typeof publisher.publish === 'function') {
    // Fallback: bentuk topik & payload minimal (api_key diisi lapisan transport).
    publisher.publish(`smartdoor/${deviceId}/${MQTT_SUBTOPIC.CMD_SUSPEND}`, { uid });
    return;
  }
  throw new TypeError(
    'publishSuspend: publisher harus menyediakan publishSuspend(deviceId, uid) atau publish(topic, payload)'
  );
}

/**
 * Jalankan satu siklus billing-lock pada waktu `now`.
 *
 * Alur:
 *   1. Pilih kandidat (kelompok A kedaluwarsa & kelompok B retry-sync).
 *   2. Dalam SATU transaksi, terapkan suspend DB untuk seluruh kandidat
 *      kelompok (A). Kegagalan DB akan me-rollback seluruh perubahan DB pada
 *      run ini (atomik) — publish belum terjadi di tahap ini.
 *   3. Setelah transaksi commit, publish `cmd/suspend` untuk tiap kartu yang
 *      memiliki device. Error publish ditangkap per-kartu dan TIDAK membatalkan
 *      suspend DB (Req 9.4). Kartu yang gagal publish dicatat di `syncFailed`
 *      dan akan dipublish ulang pada run berikutnya (karena card.db_version
 *      tetap > device.db_version sampai firmware meng-ACK & heartbeat
 *      memutakhirkan device.db_version).
 *
 * @param {Date|number|string} now waktu acuan.
 * @param {{ db: import('better-sqlite3').Database, publisher: object }} deps
 * @returns {{
 *   suspended: string[],      // uid yang baru di-suspend di DB pada run ini
 *   published: string[],      // uid yang berhasil dipublish cmd/suspend
 *   syncFailed: string[],     // uid yang suspend-nya belum tersinkron ke firmware
 *   count: number             // jumlah kartu yang baru di-suspend (= suspended.length)
 * }}
 */
function runBillingLock(now, deps = {}) {
  const { db, publisher } = deps;
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('runBillingLock: deps.db (instance better-sqlite3) wajib diisi');
  }

  const nowIso = toIso(now);
  const candidates = selectCandidates(db, nowIso);

  // Pisahkan kandidat baru-suspend (A) dari kandidat retry-sync (B).
  const toSuspend = candidates.filter((c) => c.status !== CARD_STATUS.SUSPENDED);
  const toRetry = candidates.filter((c) => c.status === CARD_STATUS.SUSPENDED);

  // 2) Terapkan seluruh perubahan DB secara atomik.
  const runTx = db.transaction((rows) => {
    for (const candidate of rows) {
      applySuspend(db, candidate);
    }
  });
  runTx(toSuspend);

  const suspended = toSuspend.map((c) => c.uid);

  // 3) Publish (best-effort) untuk kartu yang punya device: baru-suspend + retry.
  const published = [];
  const syncFailed = [];
  const toPublish = [...toSuspend, ...toRetry].filter((c) => c.device_id);

  for (const candidate of toPublish) {
    try {
      publishSuspend(publisher, candidate.device_id, candidate.uid);
      published.push(candidate.uid);
    } catch (err) {
      // Req 9.4: kegagalan sinkronisasi tidak membatalkan suspend DB; catat
      // untuk retry pada run berikutnya. Jangan sampai run crash.
      syncFailed.push(candidate.uid);
    }
  }

  return { suspended, published, syncFailed, count: suspended.length };
}

/**
 * Handle timer internal untuk siklus periodik (modul-level singleton ringan).
 * @type {ReturnType<typeof setInterval>|null}
 */
let timer = null;

/**
 * Mulai menjalankan billing-lock secara periodik.
 *
 * Wrapper sengaja tipis: hanya memanggil `runBillingLock(new Date(), ...)` pada
 * tiap tick. Error yang lolos dari satu tick ditangkap agar interval tetap
 * hidup (defensif; `runBillingLock` sendiri sudah menangani kegagalan publish).
 *
 * @param {{ intervalMs?: number, db: import('better-sqlite3').Database, publisher: object, onError?: (err:Error)=>void }} opts
 * @returns {ReturnType<typeof setInterval>} handle timer (juga disimpan internal untuk stop()).
 */
function start(opts = {}) {
  const { intervalMs = DEFAULT_INTERVAL_MS, db, publisher, onError } = opts;
  if (!db) {
    throw new TypeError('start: opts.db wajib diisi');
  }

  // Hentikan timer sebelumnya bila ada agar tidak dobel.
  stop();

  timer = setInterval(() => {
    try {
      runBillingLock(new Date(), { db, publisher });
    } catch (err) {
      if (typeof onError === 'function') {
        onError(err);
      }
      // Tanpa handler: telan error agar interval tetap berjalan.
    }
  }, intervalMs);

  // Jangan menahan event loop Node tetap hidup hanya karena timer ini.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return timer;
}

/**
 * Hentikan siklus periodik billing-lock (bersihkan timer internal).
 */
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  runBillingLock,
  start,
  stop,
  // Diekspos untuk keperluan uji lanjutan / komposisi.
  selectCandidates,
  publishSuspend,
};
