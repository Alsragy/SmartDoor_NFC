'use strict';

/**
 * Property-based tests untuk lapisan Verifikasi NFC Kripto (challenge-response
 * AES-128), modul `src/services/cryptoVerify.js`.
 *
 * Feature: smart-door-kos-esp32, Property 1: Verifikasi hanya menerima bukti
 * kripto yang benar.
 *
 * Validates: Requirements 1.1, 1.5
 *   - 1.1: Verifikasi bersifat kriptografis, tidak mengandalkan UID saja.
 *   - 1.5: Bila verifikasi kripto gagal → keputusan DENY (verify === false),
 *          relay tidak digerakkan.
 */

// `describe`, `it`, `expect` tersedia sebagai global via vitest.config.js
// (`globals: true`); Vitest v5 melarang `require('vitest')` di modul CommonJS.
const fc = require('fast-check');

const { respond, verify, BLOCK_SIZE } = require('../src/services/cryptoVerify');

/** Jumlah iterasi minimum per property (>=100 sesuai permintaan tugas). */
const NUM_RUNS = 200;

/** Arbitrary Buffer biner berukuran tepat 16 byte (nonce / diversified key). */
const buf16 = fc
  .uint8Array({ minLength: BLOCK_SIZE, maxLength: BLOCK_SIZE })
  .map((u8) => Buffer.from(u8));

describe('Feature: smart-door-kos-esp32, Property 1: Verifikasi hanya menerima bukti kripto yang benar', () => {
  it('menerima bukti kripto yang benar: verify(nonce, respond(nonce, key), key) === true', () => {
    fc.assert(
      fc.property(buf16, buf16, (nonce, key) => {
        const response = respond(nonce, key);
        return verify(nonce, response, key) === true;
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('menolak bukti kripto yang di-tamper (flip satu bit response → DENY)', () => {
    fc.assert(
      fc.property(
        buf16,
        buf16,
        fc.nat({ max: BLOCK_SIZE - 1 }),
        fc.integer({ min: 0, max: 7 }),
        (nonce, key, byteIdx, bitIdx) => {
          const correct = respond(nonce, key);
          const tampered = Buffer.from(correct);
          tampered[byteIdx] ^= 1 << bitIdx; // balikkan tepat satu bit
          // tampered pasti berbeda dari correct → harus DENY.
          return verify(nonce, tampered, key) === false;
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('menolak response acak yang berbeda dari response benar → DENY', () => {
    fc.assert(
      fc.property(buf16, buf16, buf16, (nonce, key, candidate) => {
        const correct = respond(nonce, key);
        // Hanya uji kasus di mana kandidat memang berbeda dari response benar.
        fc.pre(!candidate.equals(correct));
        return verify(nonce, candidate, key) === false;
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('menolak impostor UID-only yang memakai kunci berbeda (kloning tanpa kunci) → DENY', () => {
    fc.assert(
      fc.property(buf16, buf16, buf16, (nonce, realKey, wrongKey) => {
        // Impostor tidak memiliki diversified key asli, hanya bisa membalas
        // dengan kunci lain (wrongKey). Bila kunci berbeda menghasilkan
        // response berbeda, verifikasi terhadap kunci asli harus DENY.
        const impostorResponse = respond(nonce, wrongKey);
        fc.pre(!wrongKey.equals(realKey));
        // Jika secara kebetulan response impostor sama dengan response benar,
        // lewati (tabrakan teoretis sangat jarang untuk AES-128).
        const correct = respond(nonce, realKey);
        fc.pre(!impostorResponse.equals(correct));
        return verify(nonce, impostorResponse, realKey) === false;
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('menolak response dengan panjang salah (bukan 16 byte) → DENY, tanpa melempar', () => {
    fc.assert(
      fc.property(
        buf16,
        buf16,
        fc.uint8Array({ minLength: 0, maxLength: 32 }).filter((u8) => u8.length !== BLOCK_SIZE),
        (nonce, key, badResponse) => {
          return verify(nonce, Buffer.from(badResponse), key) === false;
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
