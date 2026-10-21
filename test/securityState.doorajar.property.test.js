'use strict';

/**
 * Property-based test — Smart Door KOS ESP32.
 *
 * Feature: smart-door-kos-esp32, Property 17: Alarm door-ajar sesuai timeout
 *
 * Memverifikasi sifat universal dari `doorAjar.isAlarm(openDurationMs, timeoutMs)`:
 *  - Alarm door-ajar aktif JIKA DAN HANYA JIKA durasi pintu terbuka MELEBIHI
 *    `Door_Ajar_Timeout`, yakni `openDurationMs > timeoutMs`.
 *  - Batas bersifat EKSKLUSIF: saat `openDurationMs === timeoutMs`, alarm BELUM
 *    aktif (false). Pada `timeoutMs + 1` alarm aktif (true); pada `timeoutMs - 1`
 *    alarm tidak aktif (false).
 *
 * Validates: Requirements 17.4
 */

// `describe`/`it`/`expect` tersedia sebagai global (vitest.config.js:
// `globals: true`). Konfigurasi proyek melarang `require('vitest')` pada modul
// CommonJS, jadi kita mengandalkan global tersebut — konsisten dengan test lain.
const fc = require('fast-check');

const { doorAjar } = require('../src/services/securityState');

/** Jumlah iterasi minimum per properti (>= 100 sesuai instruksi tugas). */
const NUM_RUNS = 300;

/**
 * Durasi/timeout dalam milidetik — bilangan bulat non-negatif dalam rentang
 * yang realistis namun cukup lebar untuk menguji perbandingan.
 */
const durationArb = fc.integer({ min: 0, max: 2_000_000_000 });

describe('Feature: smart-door-kos-esp32, Property 17: Alarm door-ajar sesuai timeout', () => {
  it('alarm aktif iff durasi terbuka > Door_Ajar_Timeout (batas eksklusif)', () => {
    fc.assert(
      fc.property(durationArb, durationArb, (openDurationMs, timeoutMs) => {
        // Ekspektasi dibangun INDEPENDEN dari implementasi.
        const expected = openDurationMs > timeoutMs;

        const actual = doorAjar.isAlarm(openDurationMs, timeoutMs);

        expect(actual).toBe(expected);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('kasus batas: durasi === timeout tidak memicu alarm (eksklusif)', () => {
    fc.assert(
      fc.property(durationArb, (timeoutMs) => {
        expect(doorAjar.isAlarm(timeoutMs, timeoutMs)).toBe(false);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('kasus batas: timeout + 1 memicu alarm; timeout - 1 tidak', () => {
    fc.assert(
      // min 1 agar `timeoutMs - 1` tetap non-negatif.
      fc.property(fc.integer({ min: 1, max: 2_000_000_000 }), (timeoutMs) => {
        expect(doorAjar.isAlarm(timeoutMs + 1, timeoutMs)).toBe(true);
        expect(doorAjar.isAlarm(timeoutMs - 1, timeoutMs)).toBe(false);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
