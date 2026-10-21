'use strict';

/**
 * Property-based test — Smart Door KOS ESP32.
 *
 * Feature: smart-door-kos-esp32, Property 10: Ingest log bersifat idempoten.
 *
 * Memverifikasi sifat universal dari `auditTrail.recordLogs`:
 *  - Untuk sembarang daftar log (yang `idempotency_key`-nya mungkin memuat
 *    duplikat), setelah satu kali `recordLogs(logs, source, db)`:
 *      * jumlah baris tersimpan di `access_logs` SAMA DENGAN jumlah
 *        idempotency_key yang DISTINCT pada daftar; dan
 *      * `accepted_ids` tepat berisi key distinct tersebut, pada urutan
 *        kemunculan PERTAMA di daftar.
 *  - Menjalankan `recordLogs` KEMBALI dengan daftar yang sama tidak menambah
 *    baris apa pun: `access_logs` tetap sama jumlahnya dan `accepted_ids` dari
 *    panggilan kedua kosong.
 *
 * Oracle jumlah key distinct dibangun INDEPENDEN dari implementasi memakai
 * `new Set(keys).size` (dan `Set` untuk urutan kemunculan pertama). Tiap
 * eksekusi memakai DB `:memory:` yang terisolasi agar tidak ada state bocor.
 *
 * `device_id`/`uid` pada `access_logs` adalah FK nullable (ON DELETE SET NULL),
 * sehingga di sini sengaja di-null-kan agar tidak perlu menyemai baris devices/
 * cards — ini tidak memengaruhi sifat idempotensi yang diuji.
 *
 * Validates: Requirements 6.4, 19.2, 19.3
 */

// `describe`/`it`/`expect` tersedia sebagai global (vitest.config.js:
// `globals: true`). Proyek melarang `require('vitest')` di modul CommonJS,
// jadi kita mengandalkan global tersebut — konsisten dengan konfigurasi proyek.
const fc = require('fast-check');

const { recordLogs } = require('../src/services/auditTrail');
const { createDatabase } = require('../src/db');

/** Jumlah iterasi minimum per properti (>= 100 sesuai instruksi tugas). */
const NUM_RUNS = 200;

/** Hitung jumlah baris yang tersimpan pada access_logs. */
function countRows(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM access_logs').get().n;
}

/**
 * Oracle: urutan key distinct berdasar kemunculan PERTAMA di daftar.
 * `Set` mempertahankan urutan insersi, sehingga menghasilkan key distinct
 * pada urutan kemunculan pertama — sepadan dengan semantik `accepted_ids`.
 */
function distinctKeysFirstOccurrence(keys) {
  return Array.from(new Set(keys));
}

/**
 * Arbitrary key idempotensi dari ruang KECIL agar duplikat sering muncul
 * (tujuan utama: menguji perilaku idempoten terhadap key berulang).
 */
const keyArb = fc
  .integer({ min: 0, max: 8 })
  .map((n) => `key-${String(n).padStart(3, '0')}`);

/**
 * Arbitrary satu objek log dari sebuah key. `device_id`/`uid` di-null-kan
 * (FK nullable) agar DB tidak perlu disemai; `result`/`ts`/`ts_unverified`
 * dibuat variatif namun valid terhadap skema.
 */
const logFromKey = (idempotency_key) =>
  fc
    .record({
      result: fc.constantFrom('GRANT', 'DENY'),
      ts: fc.constant('2025-06-18T09:12:03Z'),
      ts_unverified: fc.constantFrom(0, 1),
    })
    .map((rest) => ({
      idempotency_key,
      device_id: null,
      uid: null,
      ...rest,
    }));

/** Daftar log: array dengan key yang MUNGKIN memuat duplikat (boleh kosong). */
const logsArb = fc
  .array(keyArb, { minLength: 0, maxLength: 40 })
  .chain((keys) =>
    keys.length === 0 ? fc.constant([]) : fc.tuple(...keys.map(logFromKey))
  )
  .map((arr) => Array.from(arr));

describe('Feature: smart-door-kos-esp32, Property 10: Ingest log bersifat idempoten', () => {
  it('baris tersimpan = jumlah key unik; accepted_ids = key distinct (kemunculan pertama)', () => {
    fc.assert(
      fc.property(logsArb, fc.constantFrom('REALTIME', 'CACHED_OFFLINE'), (logs, source) => {
        const db = createDatabase(':memory:');
        try {
          const keys = logs.map((l) => l.idempotency_key);
          const expectedDistinct = distinctKeysFirstOccurrence(keys);

          const { accepted_ids } = recordLogs(logs, source, db);

          // accepted_ids tepat = key distinct pada urutan kemunculan pertama.
          expect(accepted_ids).toEqual(expectedDistinct);

          // Jumlah baris tersimpan = jumlah key distinct.
          expect(countRows(db)).toBe(expectedDistinct.length);
          expect(expectedDistinct.length).toBe(new Set(keys).size);
        } finally {
          db.close();
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('ingest ganda tidak menambah baris; accepted_ids panggilan kedua kosong', () => {
    fc.assert(
      fc.property(logsArb, fc.constantFrom('REALTIME', 'CACHED_OFFLINE'), (logs, source) => {
        const db = createDatabase(':memory:');
        try {
          const first = recordLogs(logs, source, db);
          const rowsAfterFirst = countRows(db);

          const second = recordLogs(logs, source, db);
          const rowsAfterSecond = countRows(db);

          // Panggilan kedua tidak menerima key baru apa pun.
          expect(second.accepted_ids).toEqual([]);

          // Jumlah baris tidak bertambah sama sekali.
          expect(rowsAfterSecond).toBe(rowsAfterFirst);

          // Dan tetap sama dengan jumlah key distinct dari ingest pertama.
          expect(rowsAfterFirst).toBe(first.accepted_ids.length);
        } finally {
          db.close();
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
