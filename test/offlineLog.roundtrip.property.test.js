'use strict';

/**
 * Property-based test — Smart Door KOS ESP32.
 *
 * Feature: smart-door-kos-esp32, Property 8: Round-trip serialisasi log offline
 *
 * Memverifikasi sifat universal round-trip pada lapisan serialisasi antrean
 * offline-log (`offlineLog`):
 *  - Round-trip: untuk sembarang event log valid, `parse(serialize(event))`
 *    setara (deep-equal) dengan event semula — termasuk kehadiran field opsional
 *    `ts_unverified` saat diset dan ketidakhadirannya saat tidak diset.
 *  - Invarian satu-baris: output `serialize` tidak pernah memuat karakter newline
 *    ('\n') — satu kejadian akses = satu baris JSONL (tahan korupsi parsial).
 *  - Append antrean: menambahkan satu baris terserialisasi ke array antrean
 *    menambah panjang antrean tepat +1.
 *
 * Validates: Requirements 5.1
 */

// `describe`/`it`/`expect` tersedia sebagai global via vitest.config.js
// (`globals: true`); Vitest v5 melarang `require('vitest')` di modul CommonJS.
const fc = require('fast-check');

const { serialize, parse } = require('../src/services/offlineLog');

/** Jumlah iterasi minimum per properti (>= 100 sesuai instruksi tugas). */
const NUM_RUNS = 200;

/**
 * Arbitrary untuk timestamp ISO-8601 UTC (mis. "2025-06-18T09:12:03Z").
 * Dihasilkan dari tanggal arbitrary lalu diformat ke ISO string.
 */
const isoTsArb = fc
  .date({
    min: new Date('2000-01-01T00:00:00Z'),
    max: new Date('2100-01-01T00:00:00Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

/**
 * Arbitrary untuk event log offline sesuai bentuk di `offlineLog.js`.
 * Field `ts_unverified` bersifat opsional (0 | 1); saat tidak dibangkitkan,
 * field tersebut benar-benar tidak ada pada objek (menguji ketidakhadirannya).
 */
const logEventArb = fc
  .record(
    {
      id: fc.string(),
      ts: isoTsArb,
      uid: fc.string(),
      result: fc.constantFrom('GRANT', 'DENY'),
      sync_type: fc.constantFrom('REALTIME', 'CACHED_OFFLINE'),
      ts_unverified: fc.constantFrom(0, 1),
    },
    { requiredKeys: ['id', 'ts', 'uid', 'result', 'sync_type'] },
  );

describe('Feature: smart-door-kos-esp32, Property 8: Round-trip serialisasi log offline', () => {
  it('Round-trip: parse(serialize(event)) setara (deep-equal) dengan event semula', () => {
    fc.assert(
      fc.property(logEventArb, (event) => {
        const line = serialize(event);
        const restored = parse(line);

        // Event hasil parse identik dengan event awal, termasuk kehadiran /
        // ketidakhadiran field opsional `ts_unverified`.
        expect(restored).toEqual(event);
        expect('ts_unverified' in restored).toBe('ts_unverified' in event);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('Invarian satu-baris: output serialize tidak memuat newline', () => {
    fc.assert(
      fc.property(logEventArb, (event) => {
        const line = serialize(event);

        expect(line.includes('\n')).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('Append antrean: menambah satu baris terserialisasi menambah panjang +1', () => {
    fc.assert(
      fc.property(fc.array(logEventArb), logEventArb, (initialEvents, event) => {
        const queue = initialEvents.map((e) => serialize(e));
        const before = queue.length;

        queue.push(serialize(event));

        expect(queue.length).toBe(before + 1);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
