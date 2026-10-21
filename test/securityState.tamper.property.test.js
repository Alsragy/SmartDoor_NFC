'use strict';

/**
 * Property-based test — Smart Door KOS ESP32.
 *
 * Feature: smart-door-kos-esp32, Property 14: Pemicu deteksi tamper
 *
 * Memverifikasi sifat universal dari `tamper.onDoorTransition`:
 *  - Untuk sembarang URUTAN observasi pintu (tiap langkah berupa
 *    { doorOpen, relayEngaged }), dimulai dari `tamper.initialState()`
 *    (pintu dianggap TERTUTUP), event `tamper` dipicu pada suatu langkah
 *    JIKA DAN HANYA JIKA pintu BERALIH dari tertutup → terbuka sementara
 *    relay TIDAK diaktifkan pada langkah tersebut, yaitu:
 *      doorOpen === true  (kini terbuka)
 *      DAN prevDoorOpen === false  (sebelumnya tertutup)
 *      DAN relayEngaged === false  (tanpa unlock sah)
 *  - State yang dikembalikan selalu melacak status pintu terkini (`doorOpen`).
 *
 * Oracle dibangun INDEPENDEN dari implementasi: kita melacak `prevDoorOpen`
 * sendiri (mulai dari false) lalu membandingkan event & state di tiap langkah.
 *
 * Validates: Requirements 13.2
 */

// `describe`/`it`/`expect` tersedia sebagai global (vitest.config.js:
// `globals: true`). Vitest v5 melarang `require('vitest')` di modul CommonJS,
// jadi kita mengandalkan global tersebut — konsisten dengan konfigurasi proyek.
const fc = require('fast-check');

const { tamper } = require('../src/services/securityState');

/** Jumlah iterasi minimum per properti (>= 100 sesuai instruksi tugas). */
const NUM_RUNS = 300;

/** Satu observasi pintu: { doorOpen, relayEngaged }. */
const observationArb = fc.record({
  doorOpen: fc.boolean(),
  relayEngaged: fc.boolean(),
});

/** Urutan observasi (boleh kosong hingga panjang wajar). */
const sequenceArb = fc.array(observationArb, { minLength: 0, maxLength: 40 });

describe('Feature: smart-door-kos-esp32, Property 14: Pemicu deteksi tamper', () => {
  it('tamper dipicu iff transisi tertutup→terbuka tanpa relay; state melacak doorOpen terkini', () => {
    fc.assert(
      fc.property(sequenceArb, (sequence) => {
        let state = tamper.initialState();
        // Oracle: status pintu sebelumnya, dimulai dari tertutup (false).
        let prevDoorOpen = false;

        for (const obs of sequence) {
          const { state: nextState, event } = tamper.onDoorTransition(
            state,
            obs.doorOpen,
            obs.relayEngaged
          );

          const shouldTamper =
            obs.doorOpen === true &&
            prevDoorOpen === false &&
            obs.relayEngaged === false;

          if (shouldTamper) {
            expect(event).toEqual({ type: 'tamper' });
          } else {
            expect(event).toBeNull();
          }

          // State harus melacak status pintu terkini.
          expect(nextState.doorOpen).toBe(obs.doorOpen === true);

          state = nextState;
          prevDoorOpen = obs.doorOpen === true;
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('kasus tertarget: open-dengan-relay tidak memicu tamper (unlock sah)', () => {
    const start = tamper.initialState();
    const { event } = tamper.onDoorTransition(start, true, true);
    expect(event).toBeNull();
  });

  it('kasus tertarget: tertutup→terbuka tanpa relay memicu tamper', () => {
    const start = tamper.initialState();
    const { state, event } = tamper.onDoorTransition(start, true, false);
    expect(event).toEqual({ type: 'tamper' });
    expect(state.doorOpen).toBe(true);
  });

  it('kasus tertarget: tetap terbuka (terbuka→terbuka) tidak memicu event lagi', () => {
    const start = tamper.initialState();
    // Langkah pertama memicu tamper (tertutup→terbuka tanpa relay).
    const first = tamper.onDoorTransition(start, true, false);
    expect(first.event).toEqual({ type: 'tamper' });

    // Pintu tetap terbuka: tidak ada event lanjutan, baik dengan/tanpa relay.
    const second = tamper.onDoorTransition(first.state, true, false);
    expect(second.event).toBeNull();
    expect(second.state.doorOpen).toBe(true);

    const third = tamper.onDoorTransition(second.state, true, true);
    expect(third.event).toBeNull();
    expect(third.state.doorOpen).toBe(true);
  });
});
