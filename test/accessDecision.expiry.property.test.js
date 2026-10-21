'use strict';

/**
 * Property-based test — Smart Door KOS ESP32.
 *
 * Feature: smart-door-kos-esp32, Property 5: Status kedaluwarsa menolak akses
 *
 * Memverifikasi sifat universal dari lapisan keputusan akses terkait masa
 * berlaku kartu (billing-lock, Req 9.2) dan penolakan status Suspended
 * (Req 9.3):
 *
 *   1. `effectiveStatus(card, now)` === SUSPENDED JIKA DAN HANYA JIKA kartu
 *      memiliki `expired_at` DAN `now >= expired_at`. Selain itu nilainya sama
 *      dengan status tersimpan kartu. Oracle dibangun INDEPENDEN dari input
 *      mentah, bukan dari implementasi.
 *   2. Kartu yang kedaluwarsa (`now >= expired_at`) ATAU berstatus tersimpan
 *      SUSPENDED → `decide(card, now, true)` (cryptoValid true) menghasilkan
 *      DENY. Kasus batas `now === expired_at` termasuk kedaluwarsa (inklusif)
 *      sehingga juga SUSPENDED/DENY.
 *
 * Validates: Requirements 9.2, 9.3
 */

// `describe`/`it`/`expect` tersedia sebagai global (vitest.config.js:
// `globals: true`). Proyek melarang `require('vitest')` di modul CommonJS,
// jadi kita mengandalkan global tersebut — konsisten dengan konfigurasi proyek.
const fc = require('fast-check');

const {
  decide,
  effectiveStatus,
} = require('../src/services/accessDecision');
const { CARD_STATUS, CARD_STATUS_VALUES } = require('../src/constants');

/** Jumlah iterasi minimum per properti (>= 100 sesuai instruksi tugas). */
const NUM_RUNS = 300;

/**
 * Batas atas rentang epoch-ms untuk `now` dan `expired_at`. Keduanya memakai
 * rentang yang SAMA & saling tumpang-tindih sehingga kasus di sekitar batas
 * (now < / === / > expired_at) sering terbangkitkan — termasuk now === expired_at.
 */
const TS_MAX = 2_000_000_000_000;

/** `now` sebagai epoch-ms. */
const nowArb = fc.integer({ min: 0, max: TS_MAX });

/**
 * `expired_at` sebagai epoch-ms ATAU null (kartu tanpa masa berlaku → tidak
 * pernah kedaluwarsa). Rentang disamakan dengan `now`.
 */
const expiredAtArb = fc.oneof(
  fc.constant(null),
  fc.integer({ min: 0, max: TS_MAX })
);

/** Status tersimpan kartu: salah satu dari seluruh status valid. */
const statusArb = fc.constantFrom(...CARD_STATUS_VALUES);

/** Kartu whitelist: { status, expired_at }. */
const cardArb = fc.record({
  status: statusArb,
  expired_at: expiredAtArb,
});

/**
 * Oracle kedaluwarsa, dibangun langsung dari input mentah (independen dari
 * implementasi): true iff ada `expired_at` DAN `now >= expired_at`.
 */
function isExpiredOracle(card, now) {
  const hasExpiry = card.expired_at !== null && card.expired_at !== undefined;
  return hasExpiry && now >= card.expired_at;
}

/**
 * Oracle status efektif, independen dari implementasi:
 *  - SUSPENDED iff kedaluwarsa;
 *  - selain itu status tersimpan kartu.
 */
function effectiveStatusOracle(card, now) {
  return isExpiredOracle(card, now) ? CARD_STATUS.SUSPENDED : card.status;
}

describe('Feature: smart-door-kos-esp32, Property 5: Status kedaluwarsa menolak akses', () => {
  it('effectiveStatus === SUSPENDED iff (ada expired_at & now >= expired_at); selain itu == status tersimpan', () => {
    fc.assert(
      fc.property(cardArb, nowArb, (card, now) => {
        const expected = effectiveStatusOracle(card, now);
        const actual = effectiveStatus(card, now);

        expect(actual).toBe(expected);

        // Penegasan biimplikasi SUSPENDED <-> kedaluwarsa pada kartu yang
        // status tersimpannya BUKAN SUSPENDED (agar "iff" terbukti dua arah).
        if (card.status !== CARD_STATUS.SUSPENDED) {
          const expired = isExpiredOracle(card, now);
          expect(actual === CARD_STATUS.SUSPENDED).toBe(expired);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('kedaluwarsa (now >= expired_at) ATAU status SUSPENDED => decide(...,true) == DENY', () => {
    fc.assert(
      fc.property(cardArb, nowArb, (card, now) => {
        const expired = isExpiredOracle(card, now);
        const suspended = card.status === CARD_STATUS.SUSPENDED;

        // Hanya tegaskan properti ini untuk kartu yang memang kedaluwarsa atau
        // Suspended; kartu lain tidak dibatasi oleh Property 5.
        fc.pre(expired || suspended);

        const actual = decide(card, now, true);
        expect(actual.result).toBe('DENY');
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('batas now === expired_at => SUSPENDED (inklusif) dan DENY meski ACTIVE & cryptoValid', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: TS_MAX }), (ts) => {
        const card = { status: CARD_STATUS.ACTIVE, expired_at: ts };

        // Batas inklusif: now === expired_at => kedaluwarsa => SUSPENDED.
        expect(effectiveStatus(card, ts)).toBe(CARD_STATUS.SUSPENDED);

        // Dan keputusan menolak akses walau status tersimpan ACTIVE & kripto valid.
        expect(decide(card, ts, true).result).toBe('DENY');
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
