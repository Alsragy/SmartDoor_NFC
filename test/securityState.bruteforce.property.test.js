'use strict';

/**
 * Property-based test — Smart Door KOS ESP32.
 *
 * Feature: smart-door-kos-esp32, Property 13: Pemicu deteksi brute-force
 *
 * Memverifikasi sifat universal dari `bruteForce.onTap`:
 *  - Untuk sembarang urutan tap (masing-masing boolean `isKnown`), lipat
 *    (fold) urutan tersebut melalui `bruteForce.onTap` mulai dari
 *    `initialState()`. Event `brute_force` dipicu TEPAT ketika penghitung tap
 *    tak dikenal berturut-turut MELEBIHI ambang (`> 3`) — yakni pada tap tak
 *    dikenal ke-4 dan setiap tap tak dikenal berikutnya — sedangkan tap yang
 *    DIKENAL mereset penghitung ke 0.
 *  - Ekspektasi (keberadaan event + nilai `count`) dihitung oleh ORACLE
 *    independen di tiap langkah, lalu dibandingkan dengan keluaran modul.
 *
 * Validates: Requirements 13.1
 */

// `describe`/`it`/`expect` tersedia sebagai global (vitest.config.js:
// `globals: true`). Vitest v5 melarang `require('vitest')` di modul CommonJS.
const fc = require('fast-check');

const {
  BRUTE_FORCE_THRESHOLD,
  bruteForce,
} = require('../src/services/securityState');

/** Jumlah iterasi minimum per properti (>= 100 sesuai instruksi tugas). */
const NUM_RUNS = 300;

/** Urutan tap arbitrer: array boolean `isKnown` (true = kartu dikenal). */
const tapSequenceArb = fc.array(fc.boolean(), { minLength: 0, maxLength: 60 });

describe('Feature: smart-door-kos-esp32, Property 13: Pemicu deteksi brute-force', () => {
  it('fold urutan tap → event & count cocok dengan oracle independen di tiap langkah', () => {
    fc.assert(
      fc.property(tapSequenceArb, (taps) => {
        let state = bruteForce.initialState();
        // Oracle: penghitung tap tak dikenal berturut-turut, dihitung terpisah.
        let oracleCount = 0;

        for (const isKnown of taps) {
          if (isKnown) {
            oracleCount = 0;
          } else {
            oracleCount += 1;
          }
          const expectedEvent =
            oracleCount > BRUTE_FORCE_THRESHOLD
              ? { type: 'brute_force', count: oracleCount }
              : null;

          const result = bruteForce.onTap(state, isKnown);
          state = result.state;

          expect(result.event).toEqual(expectedEvent);
          // Penghitung internal state harus selalu selaras dengan oracle.
          expect(state.consecutiveUnknown).toBe(oracleCount);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('tepat 3 tap tak dikenal → tanpa event; tap ke-4 memicu; tap dikenal mereset sehingga butuh 4 lagi', () => {
    let state = bruteForce.initialState();

    // Tap tak dikenal ke-1..3: belum melebihi ambang → tanpa event.
    for (let i = 1; i <= BRUTE_FORCE_THRESHOLD; i += 1) {
      const r = bruteForce.onTap(state, false);
      state = r.state;
      expect(r.event).toBeNull();
      expect(state.consecutiveUnknown).toBe(i);
    }

    // Tap tak dikenal ke-4: melebihi ambang → event dipicu dengan count = 4.
    const fourth = bruteForce.onTap(state, false);
    state = fourth.state;
    expect(fourth.event).toEqual({ type: 'brute_force', count: 4 });
    expect(state.consecutiveUnknown).toBe(4);

    // Tap DIKENAL di tengah → mereset penghitung ke 0, tanpa event.
    const reset = bruteForce.onTap(state, true);
    state = reset.state;
    expect(reset.event).toBeNull();
    expect(state.consecutiveUnknown).toBe(0);

    // Setelah reset, 3 tap tak dikenal lagi belum memicu...
    for (let i = 1; i <= BRUTE_FORCE_THRESHOLD; i += 1) {
      const r = bruteForce.onTap(state, false);
      state = r.state;
      expect(r.event).toBeNull();
      expect(state.consecutiveUnknown).toBe(i);
    }
    // ...dan tap ke-4 (sejak reset) kembali memicu.
    const fourthAgain = bruteForce.onTap(state, false);
    state = fourthAgain.state;
    expect(fourthAgain.event).toEqual({ type: 'brute_force', count: 4 });
    expect(state.consecutiveUnknown).toBe(4);
  });
});
