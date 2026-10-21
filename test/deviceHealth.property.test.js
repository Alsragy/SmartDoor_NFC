'use strict';

/**
 * Property-based test — Smart Door KOS ESP32.
 *
 * Feature: smart-door-kos-esp32, Property 12: Klasifikasi status online/offline perangkat
 *
 * Memverifikasi sifat universal dari `deviceHealth.isOffline` / `status`:
 *  - Untuk sembarang `last_seen` (epoch-ms), `now` (epoch-ms), dan `interval`
 *    non-negatif (ms), perangkat ditandai Offline JIKA DAN HANYA JIKA
 *    `now - last_seen > interval` (strict greater-than). Selisih yang sama
 *    persis dengan `interval` masih Online.
 *  - `last_seen` null/undefined (belum pernah terlihat) → Offline (true).
 *  - `status(...)` memetakan hasil `isOffline` ke 'OFFLINE'/'ONLINE' secara
 *    konsisten.
 *
 * Ekspektasi boolean dibangun INDEPENDEN dari implementasi lalu dibandingkan.
 *
 * Validates: Requirements 11.2, 11.4
 */

// `describe`/`it`/`expect` tersedia sebagai global (vitest.config.js:
// `globals: true`). Vitest v5 melarang `require('vitest')` di modul CommonJS.
const fc = require('fast-check');

const {
  DEVICE_STATUS,
  isOffline,
  status,
} = require('../src/services/deviceHealth');

/** Jumlah iterasi minimum per properti (>= 100 sesuai instruksi tugas). */
const NUM_RUNS = 300;

/** Waktu epoch-ms dalam rentang realistis namun lebar. */
const epochArb = fc.integer({ min: 0, max: 2_000_000_000_000 });

/** Interval non-negatif dalam milidetik. */
const intervalArb = fc.integer({ min: 0, max: 2_000_000_000_000 });

describe('Feature: smart-door-kos-esp32, Property 12: Klasifikasi status online/offline perangkat', () => {
  it('isOffline(lastSeen, now, interval) === (now - lastSeen > interval) untuk input arbitrer', () => {
    fc.assert(
      fc.property(
        epochArb,
        epochArb,
        intervalArb,
        (lastSeen, now, interval) => {
          const expected = now - lastSeen > interval;
          expect(isOffline(lastSeen, now, interval)).toBe(expected);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('Batas: now - lastSeen === interval → ONLINE (false); tepat di atasnya → OFFLINE (true)', () => {
    fc.assert(
      fc.property(epochArb, intervalArb, (lastSeen, interval) => {
        // now - lastSeen == interval → masih Online (ambang ketat).
        const nowAtThreshold = lastSeen + interval;
        expect(isOffline(lastSeen, nowAtThreshold, interval)).toBe(false);
        expect(status(lastSeen, nowAtThreshold, interval)).toBe(
          DEVICE_STATUS.ONLINE
        );

        // now - lastSeen == interval + 1 → Offline.
        const nowAboveThreshold = lastSeen + interval + 1;
        expect(isOffline(lastSeen, nowAboveThreshold, interval)).toBe(true);
        expect(status(lastSeen, nowAboveThreshold, interval)).toBe(
          DEVICE_STATUS.OFFLINE
        );
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('lastSeen null/undefined → selalu Offline (belum pernah terlihat)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, undefined),
        epochArb,
        intervalArb,
        (lastSeen, now, interval) => {
          expect(isOffline(lastSeen, now, interval)).toBe(true);
          expect(status(lastSeen, now, interval)).toBe(DEVICE_STATUS.OFFLINE);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('status(...) memetakan isOffline ke OFFLINE/ONLINE secara konsisten', () => {
    fc.assert(
      fc.property(
        epochArb,
        epochArb,
        intervalArb,
        (lastSeen, now, interval) => {
          const offline = isOffline(lastSeen, now, interval);
          const expectedStatus = offline
            ? DEVICE_STATUS.OFFLINE
            : DEVICE_STATUS.ONLINE;
          expect(status(lastSeen, now, interval)).toBe(expectedStatus);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
