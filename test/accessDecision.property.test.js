'use strict';

/**
 * Property-based test — Smart Door KOS ESP32.
 *
 * Feature: smart-door-kos-esp32, Property 4: Keputusan akses dari whitelist lokal
 *
 * Memverifikasi sifat universal dari `accessDecision.decide`:
 *  - Untuk sembarang kartu (status apa pun & `expired_at` relatif terhadap
 *    `now` apa pun) dan sembarang `cryptoValid`, hasil keputusan adalah GRANT
 *    JIKA DAN HANYA JIKA:
 *      cryptoValid === true
 *      DAN status efektif ACTIVE (bukan SUSPENDED/REVOKED/UNPROVISIONED)
 *      DAN kartu belum kedaluwarsa (tidak ada expiry, atau now < expired_at).
 *    Selain itu DENY.
 *
 * Catatan offline: `decide` adalah fungsi MURNI/lokal — tidak ada argumen atau
 * flag jaringan sama sekali. Keputusan hanya bergantung pada kartu whitelist
 * lokal, `now`, dan `cryptoValid`. Karena itu hasilnya identik baik perangkat
 * online maupun offline; kondisi offline tercakup secara konseptual oleh sifat
 * kemurnian ini (tidak perlu disimulasikan dengan flag jaringan).
 *
 * Validates: Requirements 3.4, 4.2, 9.3
 */

// `describe`/`it`/`expect` tersedia sebagai global (vitest.config.js:
// `globals: true`). Vitest v5 melarang `require('vitest')` di modul CommonJS,
// jadi kita mengandalkan global tersebut — konsisten dengan konfigurasi proyek.
const fc = require('fast-check');

const { decide } = require('../src/services/accessDecision');
const { CARD_STATUS, CARD_STATUS_VALUES } = require('../src/constants');

/** Jumlah iterasi minimum per properti (>= 100 sesuai instruksi tugas). */
const NUM_RUNS = 300;

/**
 * `now` sebagai epoch-ms dalam rentang yang realistis (sekitar 1970..~2033)
 * namun cukup lebar untuk menguji perbandingan waktu.
 */
const nowArb = fc.integer({ min: 0, max: 2_000_000_000_000 });

/**
 * `expired_at` sebagai epoch-ms, ATAU null (kartu tanpa masa berlaku).
 * Rentang disamakan dengan `now` agar sering menghasilkan kasus di sekitar
 * batas kedaluwarsa (now < / == / > expired_at).
 */
const expiredAtArb = fc.oneof(
  fc.constant(null),
  fc.integer({ min: 0, max: 2_000_000_000_000 })
);

/** Status tersimpan kartu: salah satu dari seluruh status valid. */
const statusArb = fc.constantFrom(...CARD_STATUS_VALUES);

/** Kartu whitelist: { status, expired_at }. */
const cardArb = fc.record({
  status: statusArb,
  expired_at: expiredAtArb,
});

/**
 * Ekspektasi dibangun INDEPENDEN dari implementasi `decide`, langsung dari
 * input mentah, lalu dibandingkan dengan hasil `decide`.
 *
 * @param {{status: string, expired_at: number|null}} card
 * @param {number} now epoch-ms
 * @param {boolean} cryptoValid
 * @returns {'GRANT'|'DENY'}
 */
function expectedResult(card, now, cryptoValid) {
  // Kedaluwarsa iff ada expired_at DAN now >= expired_at.
  const hasExpiry = card.expired_at !== null && card.expired_at !== undefined;
  const expired = hasExpiry && now >= card.expired_at;

  // Status efektif ACTIVE hanya jika status tersimpan ACTIVE dan belum expired.
  const effectiveActive = card.status === CARD_STATUS.ACTIVE && !expired;

  return cryptoValid === true && effectiveActive ? 'GRANT' : 'DENY';
}

describe('Feature: smart-door-kos-esp32, Property 4: Keputusan akses dari whitelist lokal', () => {
  it('GRANT iff cryptoValid & status efektif ACTIVE & belum kedaluwarsa; selain itu DENY (termasuk kasus offline/murni)', () => {
    fc.assert(
      fc.property(cardArb, nowArb, fc.boolean(), (card, now, cryptoValid) => {
        const expected = expectedResult(card, now, cryptoValid);

        // Gaya pemanggilan: decide(card, now, cryptoValid).
        const actual = decide(card, now, cryptoValid);

        expect(actual.result).toBe(expected);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Kasus batas now === expired_at menolak akses (kedaluwarsa inklusif) meski ACTIVE & cryptoValid', () => {
    fc.assert(
      fc.property(nowArb, (ts) => {
        const card = { status: CARD_STATUS.ACTIVE, expired_at: ts };
        // now === expired_at => now >= expired_at => kedaluwarsa => DENY.
        const actual = decide(card, ts, true);
        expect(actual.result).toBe('DENY');
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
