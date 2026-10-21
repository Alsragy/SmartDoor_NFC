'use strict';

/**
 * Logika keputusan akses dari whitelist — Smart Door KOS ESP32.
 *
 * Modul MURNI (tanpa efek samping): tidak menyentuh I/O, jaringan, relay,
 * maupun waktu sistem. Semua input (kartu, waktu `now`, validitas kripto)
 * diberikan secara eksplisit sebagai argumen agar deterministik & mudah diuji
 * (property-based). Ini juga menjadi referensi portabel untuk lapisan
 * keputusan firmware (port C++ di `firmware/lib/decision/`).
 *
 * Catatan Req 3.5: modul ini HANYA mengatur logika keputusan akses, bukan
 * aktuasi fisik relay. Modul tidak menggerakkan apa pun — hanya mengembalikan
 * GRANT/DENY.
 *
 * Properti terkait (design.md):
 *   - Property 4: Keputusan akses dari whitelist lokal (GRANT tepat saat tidak
 *     Suspended & belum kedaluwarsa, bahkan offline; selain itu DENY).
 *   - Property 5: Status kedaluwarsa menolak akses (status efektif SUSPENDED
 *     iff `now >= expired_at`; kartu Suspended → DENY).
 *
 * _Requirements: 3.4, 4.2, 9.2, 9.3_
 */

const { CARD_STATUS } = require('../constants');

/** Hasil keputusan akses. */
const DECISION = Object.freeze({
  GRANT: 'GRANT',
  DENY: 'DENY',
});

/**
 * Normalisasi `now` dan `expired_at` ke milidetik epoch untuk perbandingan.
 * Menerima Date, number (epoch ms), atau string ISO-8601.
 * @param {Date|number|string} value
 * @returns {number} epoch ms, atau NaN jika tidak dapat diinterpretasikan.
 */
function toEpochMs(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return Date.parse(value);
  }
  return NaN;
}

/**
 * Tentukan apakah sebuah kartu sudah kedaluwarsa pada waktu `now`.
 *
 * `expired_at` yang tidak ada / null / undefined berarti kartu TIDAK memiliki
 * masa berlaku → tidak pernah kedaluwarsa.
 *
 * @param {{ expired_at?: Date|number|string|null }} card entri kartu.
 * @param {Date|number|string} now waktu acuan.
 * @returns {boolean} true iff `now >= expired_at` (expired_at valid & terlampaui).
 */
function isExpired(card, now) {
  const expiredAt = card == null ? null : card.expired_at;
  if (expiredAt === null || expiredAt === undefined || expiredAt === '') {
    return false; // tanpa masa berlaku → tidak kedaluwarsa
  }
  const expiredMs = toEpochMs(expiredAt);
  const nowMs = toEpochMs(now);
  if (Number.isNaN(expiredMs) || Number.isNaN(nowMs)) {
    return false; // waktu tak terbaca → perlakukan sebagai tidak kedaluwarsa
  }
  return nowMs >= expiredMs;
}

/**
 * Status efektif kartu pada waktu `now`.
 *
 * Kartu yang sudah kedaluwarsa (`now >= expired_at`) diperlakukan sebagai
 * SUSPENDED secara efektif, meskipun status tersimpannya masih ACTIVE
 * (billing-lock, Req 9.2). Selain itu, kembalikan status tersimpan kartu.
 *
 * @param {{ status?: string, expired_at?: Date|number|string|null }} card
 * @param {Date|number|string} now waktu acuan.
 * @returns {string} status efektif (nilai dari CARD_STATUS).
 */
function effectiveStatus(card, now) {
  if (isExpired(card, now)) {
    return CARD_STATUS.SUSPENDED;
  }
  return card && card.status ? card.status : CARD_STATUS.UNPROVISIONED;
}

/**
 * Status efektif yang mengizinkan akses (bukan penghalang GRANT).
 * Hanya ACTIVE yang mengizinkan; SUSPENDED/REVOKED/UNPROVISIONED menolak.
 */
const GRANTABLE_STATUS = Object.freeze([CARD_STATUS.ACTIVE]);

/**
 * Normalisasi argumen `decide` ke bentuk { cryptoValid, card }.
 * Mendukung dua gaya pemanggilan:
 *   1. decide({ cryptoValid, card }, now)
 *   2. decide(card, now, cryptoValid)
 */
function normalizeDecideArgs(first, cryptoValidArg) {
  if (
    first != null &&
    typeof first === 'object' &&
    ('cryptoValid' in first || 'card' in first)
  ) {
    return { cryptoValid: first.cryptoValid === true, card: first.card };
  }
  return { cryptoValid: cryptoValidArg === true, card: first };
}

/**
 * Keputusan akses untuk sebuah kartu pada waktu `now`.
 *
 * Mengembalikan GRANT iff SEMUA benar:
 *   - `cryptoValid === true` (verifikasi kriptografis lolos, Req 1.5), DAN
 *   - status efektif adalah ACTIVE — yakni bukan SUSPENDED, REVOKED, maupun
 *     UNPROVISIONED (Req 9.3), DAN
 *   - kartu belum kedaluwarsa `now < expired_at` (Req 9.2).
 * Selain itu DENY. Keputusan murni berbasis whitelist lokal sehingga tetap
 * berlaku dalam kondisi offline (Req 3.4, 4.2).
 *
 * Validitas kripto adalah input eksplisit agar modul ini murni & dapat diuji
 * tanpa menjalankan verifikasi kripto yang sesungguhnya.
 *
 * @param {{ cryptoValid?: boolean, card?: object }|object} first
 *        Objek `{ cryptoValid, card }`, ATAU kartu langsung (gaya ke-2).
 * @param {Date|number|string} now waktu acuan.
 * @param {boolean} [cryptoValid] validitas kripto (dipakai pada gaya ke-2).
 * @returns {{ result: string, reason: string }} hasil keputusan stabil.
 */
function decide(first, now, cryptoValid) {
  const { cryptoValid: isCryptoValid, card } = normalizeDecideArgs(
    first,
    cryptoValid
  );

  if (!card || typeof card !== 'object') {
    return { result: DECISION.DENY, reason: 'UNKNOWN_CARD' };
  }

  if (isCryptoValid !== true) {
    return { result: DECISION.DENY, reason: 'CRYPTO_INVALID' };
  }

  if (isExpired(card, now)) {
    return { result: DECISION.DENY, reason: 'EXPIRED' };
  }

  const status = effectiveStatus(card, now);
  if (!GRANTABLE_STATUS.includes(status)) {
    return { result: DECISION.DENY, reason: `STATUS_${status}` };
  }

  return { result: DECISION.GRANT, reason: 'OK' };
}

module.exports = {
  DECISION,
  decide,
  effectiveStatus,
  isExpired,
};
