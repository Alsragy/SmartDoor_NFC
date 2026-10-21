'use strict';

/**
 * Property-based test — Smart Door KOS ESP32.
 *
 * Feature: smart-door-kos-esp32, Property 2: Round-trip challenge-response AES-128
 *
 * Memverifikasi sifat universal round-trip pada lapisan verifikasi kripto
 * (`cryptoVerify`):
 *  - Round-trip: untuk sembarang nonce 16-byte dan diversified key 16-byte,
 *    `recover(respond(nonce, key), key)` menghasilkan nonce semula secara
 *    byte-for-byte.
 *  - Penerimaan verifikasi: `verify(nonce, respond(nonce, key), key)` === true.
 *
 * Validates: Requirements 1.3
 */

// `describe`/`it`/`expect` tersedia sebagai global via vitest.config.js
// (`globals: true`); Vitest v5 melarang `require('vitest')` di modul CommonJS.
const fc = require('fast-check');

const { respond, recover, verify, BLOCK_SIZE } = require('../src/services/cryptoVerify');

/** Jumlah iterasi minimum per properti (>= 100 sesuai instruksi tugas). */
const NUM_RUNS = 200;

/** Arbitrary untuk nonce AES-128: Buffer tepat 16 byte. */
const nonceArb = fc
  .uint8Array({ minLength: BLOCK_SIZE, maxLength: BLOCK_SIZE })
  .map((u) => Buffer.from(u));

/** Arbitrary untuk diversified key AES-128: Buffer tepat 16 byte. */
const keyArb = fc
  .uint8Array({ minLength: BLOCK_SIZE, maxLength: BLOCK_SIZE })
  .map((u) => Buffer.from(u));

describe('Feature: smart-door-kos-esp32, Property 2: Round-trip challenge-response AES-128', () => {
  it('Round-trip: recover(respond(nonce, key), key) === nonce (byte-for-byte)', () => {
    fc.assert(
      fc.property(nonceArb, keyArb, (nonce, key) => {
        const response = respond(nonce, key);
        const recovered = recover(response, key);

        // Nonce hasil dekripsi berukuran 16 byte dan identik dengan nonce awal.
        expect(recovered.length).toBe(BLOCK_SIZE);
        expect(recovered.equals(nonce)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('Acceptance: verify(nonce, respond(nonce, key), key) === true', () => {
    fc.assert(
      fc.property(nonceArb, keyArb, (nonce, key) => {
        const response = respond(nonce, key);

        // Verifikasi menerima response yang dihasilkan dengan kunci yang sama.
        expect(verify(nonce, response, key)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
