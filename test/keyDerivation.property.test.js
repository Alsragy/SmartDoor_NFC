/**
 * Property-based test — Smart Door KOS ESP32.
 *
 * Feature: smart-door-kos-esp32, Property 3: Determinisme derivasi diversified key
 *
 * Memverifikasi dua sifat universal dari `keyDerivation.derive`:
 *  - Determinisme: UID yang sama (dengan Master_Key sama) selalu menghasilkan
 *    Diversified_Key yang sama.
 *  - Distinctness: dua UID yang berbeda menghasilkan Diversified_Key yang
 *    berbeda.
 *
 * Validates: Requirements 1.4, 2.2
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createRequire } from 'node:module';

// Modul under test adalah CommonJS; muat via createRequire agar interop bersih.
const require = createRequire(import.meta.url);
const { derive } = require('../src/services/keyDerivation');

/** Jumlah iterasi minimum per properti (>= 100 sesuai instruksi tugas). */
const NUM_RUNS = 200;

/** Arbitrary untuk Master_Key AES-128: Buffer tepat 16 byte. */
const masterKeyArb = fc.uint8Array({ minLength: 16, maxLength: 16 }).map((u) => Buffer.from(u));

/** Arbitrary untuk UID kartu: Buffer 4..16 byte (rentang UID NFC yang lazim). */
const uidArb = fc.uint8Array({ minLength: 4, maxLength: 16 }).map((u) => Buffer.from(u));

// Opsi eksplisit agar derivasi tidak bergantung pada environment proses.
const OPTS = { keyVersion: 1 };

describe('Feature: smart-door-kos-esp32, Property 3: Determinisme derivasi diversified key', () => {
  it('Determinism: UID sama + Master_Key sama -> Diversified_Key identik', () => {
    fc.assert(
      fc.property(masterKeyArb, uidArb, (masterKey, uid) => {
        const a = derive(masterKey, uid, OPTS);
        const b = derive(masterKey, uid, OPTS);

        // Kunci 16-byte dan byte-for-byte identik di dua pemanggilan.
        expect(a.diversifiedKey.length).toBe(16);
        expect(a.diversifiedKey.equals(b.diversifiedKey)).toBe(true);
        expect(a.keyVersion).toBe(b.keyVersion);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('Distinctness: dua UID berbeda (Master_Key sama) -> Diversified_Key berbeda', () => {
    fc.assert(
      fc.property(masterKeyArb, uidArb, uidArb, (masterKey, uidA, uidB) => {
        // Hanya uji pasangan UID yang benar-benar berbeda.
        fc.pre(!uidA.equals(uidB));

        const a = derive(masterKey, uidA, OPTS);
        const b = derive(masterKey, uidB, OPTS);

        expect(a.diversifiedKey.equals(b.diversifiedKey)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
