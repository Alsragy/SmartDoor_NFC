'use strict';

/**
 * Property-based test — Smart Door KOS ESP32.
 *
 * Feature: smart-door-kos-esp32, Property 15: Penandaan Sync_Type sesuai sumber.
 *
 * Memverifikasi sifat universal dari `auditTrail.recordLog`:
 *  - Untuk sembarang log akses valid (idempotency_key unik per run, result
 *    GRANT/DENY, ts ISO-8601, device_id/uid null atau ter-seed) dan sembarang
 *    `source` ∈ {'REALTIME','CACHED_OFFLINE'}, setelah `recordLog(log, source, db)`
 *    baris yang tersimpan di `access_logs` memiliki `sync_type` yang:
 *        * REALTIME       iff source adalah jalur live/online (Req 15.2), dan
 *        * CACHED_OFFLINE iff source adalah jalur antrean offline (Req 15.3).
 *    Yakni: stored.sync_type === syncTypeForSource(source).
 *
 *  Tag `sync_type` ditentukan oleh jalur penerimaan di server (`source`), bukan
 *  klaim klien di dalam `log` — properti ini juga menegaskan hal tersebut dengan
 *  kadang menyisipkan `sync_type` palsu di dalam log.
 *
 * Validates: Requirements 15.2, 15.3
 */

// `describe`/`it`/`expect` tersedia sebagai global (vitest.config.js:
// `globals: true`). Vitest melarang `require('vitest')` di modul CommonJS pada
// proyek ini, jadi kita mengandalkan global tersebut.
const fc = require('fast-check');

const { createDatabase } = require('../src/db');
const { recordLog, syncTypeForSource } = require('../src/services/auditTrail');
const { SYNC_TYPE } = require('../src/constants');

/** Jumlah iterasi minimum per properti (>= 100 sesuai instruksi tugas). */
const NUM_RUNS = 300;

/** Nilai source yang valid — keduanya setara dengan nilai sync_type kanonik. */
const SOURCE_VALUES = Object.freeze([SYNC_TYPE.REALTIME, SYNC_TYPE.CACHED_OFFLINE]);

/**
 * Arbitrary log akses valid.
 * device_id & uid dibiarkan null agar INSERT memenuhi FK (nullable + ON DELETE
 * SET NULL pada skema) tanpa perlu menyeed devices/cards — null sah untuk FK.
 * `sync_type` sengaja diisi nilai yang mungkin bertentangan dengan `source`
 * untuk menegaskan bahwa server mengabaikan klaim klien.
 */
const logArb = fc.record({
  result: fc.constantFrom('GRANT', 'DENY'),
  // Rentang epoch-ms tetap untuk menjamin ISO-8601 valid (hindari Invalid Date).
  ts: fc
    .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 11, 31, 23, 59, 59) })
    .map((ms) => new Date(ms).toISOString()),
  ts_unverified: fc.constantFrom(0, 1),
  // Klaim sync_type dari klien (harus diabaikan server).
  sync_type: fc.constantFrom('REALTIME', 'CACHED_OFFLINE'),
});

/** Source arbitrary ∈ {REALTIME, CACHED_OFFLINE}. */
const sourceArb = fc.constantFrom(...SOURCE_VALUES);

describe('Feature: smart-door-kos-esp32, Property 15: Penandaan Sync_Type sesuai sumber', () => {
  it('stored sync_type === syncTypeForSource(source); REALTIME iff live-online, CACHED_OFFLINE iff antrean offline', () => {
    const db = createDatabase(':memory:');
    try {
      let counter = 0;
      fc.assert(
        fc.property(logArb, sourceArb, (baseLog, source) => {
          // Kunci idempotensi unik per run → hindari tabrakan ON CONFLICT.
          const idempotency_key = `k-${counter++}`;
          const log = { ...baseLog, idempotency_key, device_id: null, uid: null };

          const result = recordLog(log, source, db);
          // Baris harus benar-benar baru tersimpan (kunci unik).
          expect(result.accepted).toBe(true);

          const expectedSyncType = syncTypeForSource(source);

          // Nilai yang dikembalikan sudah mencerminkan sync_type kanonik.
          expect(result.sync_type).toBe(expectedSyncType);

          // Query baris kembali dari DB dan assert sync_type tersimpan.
          const row = db
            .prepare('SELECT sync_type FROM access_logs WHERE idempotency_key = ?')
            .get(idempotency_key);
          expect(row).toBeDefined();
          expect(row.sync_type).toBe(expectedSyncType);

          // Penegasan dua-arah (iff):
          //   REALTIME tersimpan  ⟺  source jalur live/online.
          //   CACHED_OFFLINE      ⟺  source jalur antrean offline.
          expect(row.sync_type === SYNC_TYPE.REALTIME).toBe(source === SYNC_TYPE.REALTIME);
          expect(row.sync_type === SYNC_TYPE.CACHED_OFFLINE).toBe(
            source === SYNC_TYPE.CACHED_OFFLINE
          );
        }),
        { numRuns: NUM_RUNS }
      );
    } finally {
      db.close();
    }
  });
});
