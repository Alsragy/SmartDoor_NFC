'use strict';

/**
 * Property-based tests untuk verifikasi OTA — helper murni `verifyBinary`
 * pada modul `src/routes/ota.js`.
 *
 * Feature: smart-door-kos-esp32, Property 16: OTA invalid tidak mengubah
 * firmware berjalan.
 *
 * Model keputusan apply/tolak (Req 16.3): firmware menerapkan pembaruan JIKA
 * DAN HANYA JIKA `verifyBinary(bytes, expectedChecksum) === true` (checksum/
 * validitas lolos). Bila berkas korup / checksum salah / malformed → tolak,
 * sehingga versi firmware yang sedang berjalan TIDAK berubah.
 *
 * Validates: Requirements 16.3
 */

// `describe`, `it`, `expect` tersedia sebagai global via vitest.config.js
// (`globals: true`); Vitest v5 melarang `require('vitest')` di modul CommonJS.
const crypto = require('crypto');
const fc = require('fast-check');

const { verifyBinary, sha256Hex } = require('../src/routes/ota');

/** Jumlah iterasi minimum per property (>=100 sesuai permintaan tugas). */
const NUM_RUNS = 200;

/** Oracle independen: SHA-256 hex lowercase via Node crypto (bukan dari modul). */
function oracleSha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Arbitrary Buffer biner non-kosong (mewakili berkas `.bin` firmware). */
const nonEmptyBytes = fc
  .uint8Array({ minLength: 1, maxLength: 512 })
  .map((u8) => Buffer.from(u8));

describe('Feature: smart-door-kos-esp32, Property 16: OTA invalid tidak mengubah firmware berjalan', () => {
  it('apply iff valid — checksum benar DITERIMA (firmware menerapkan update)', () => {
    fc.assert(
      fc.property(nonEmptyBytes, (bytes) => {
        const expected = oracleSha256Hex(bytes);
        // sha256Hex modul harus setara oracle Node crypto.
        expect(sha256Hex(bytes)).toBe(expected);
        // Keputusan apply: checksum cocok → true.
        return verifyBinary(bytes, expected) === true;
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('checksum benar diterima tanpa peduli huruf besar/kecil (case-insensitive)', () => {
    fc.assert(
      fc.property(nonEmptyBytes, (bytes) => {
        const expected = oracleSha256Hex(bytes);
        return (
          verifyBinary(bytes, expected.toUpperCase()) === true &&
          verifyBinary(bytes, `  ${expected.toUpperCase()}  `) === true
        );
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('berkas korup (satu byte diubah) → TOLAK; firmware berjalan tetap', () => {
    fc.assert(
      fc.property(
        nonEmptyBytes,
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (bytes, idxSeed, delta) => {
          // Checksum dihitung dari berkas ASLI, lalu kirim berkas yang KORUP.
          const expected = oracleSha256Hex(bytes);
          const corrupt = Buffer.from(bytes);
          const i = idxSeed % corrupt.length;
          corrupt[i] = (corrupt[i] + delta) & 0xff; // delta 1..255 → byte berubah
          // Berkas berbeda isi → digest berbeda → tolak (reject).
          return verifyBinary(corrupt, expected) === false;
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('checksum milik berkas lain yang berbeda → TOLAK', () => {
    fc.assert(
      fc.property(nonEmptyBytes, nonEmptyBytes, (a, b) => {
        // Hanya uji saat kedua berkas benar-benar berbeda isi.
        fc.pre(!a.equals(b));
        const checksumOfB = oracleSha256Hex(b);
        // Kolisi SHA-256 secara praktis mustahil; digest a != digest b.
        fc.pre(oracleSha256Hex(a) !== checksumOfB);
        return verifyBinary(a, checksumOfB) === false;
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('checksum malformed (non-hex / panjang salah) → TOLAK', () => {
    fc.assert(
      fc.property(
        nonEmptyBytes,
        fc
          .string({ maxLength: 80 })
          // Buang kandidat yang kebetulan berupa hex SHA-256 valid (64 digit).
          .filter((s) => !/^[0-9a-fA-F]{64}$/.test(s.trim())),
        (bytes, badChecksum) => {
          return verifyBinary(bytes, badChecksum) === false;
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('buffer kosong → TOLAK (tak ada isi biner untuk diterapkan)', () => {
    const empty = Buffer.alloc(0);
    // Meskipun checksum "benar" untuk buffer kosong, verifyBinary menolak
    // unggahan kosong (Req 16.3: korup/kosong tidak diterapkan).
    expect(verifyBinary(empty, oracleSha256Hex(empty))).toBe(false);

    // Property: untuk checksum apa pun, buffer kosong selalu ditolak.
    fc.assert(
      fc.property(fc.string(), (anyChecksum) => {
        return verifyBinary(empty, anyChecksum) === false;
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
