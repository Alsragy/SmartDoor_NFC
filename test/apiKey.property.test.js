'use strict';

/**
 * Property-based test — Smart Door KOS ESP32.
 *
 * Feature: smart-door-kos-esp32, Property 11: Autentikasi menerima iff API_Key valid
 *
 * Memverifikasi sifat universal dari `isValidApiKey(provided, env)`:
 *  - Untuk sembarang API_Key terkonfigurasi (string non-kosong) dan sembarang
 *    nilai `provided` (string, mungkin sama, mungkin beda, mungkin kosong),
 *    autentikasi DITERIMA (mengembalikan `true`) JIKA DAN HANYA JIKA:
 *      typeof provided === 'string' AND provided.length > 0 AND
 *      provided === configured.
 *    Selain itu DITOLAK (`false`).
 *  - Fail-closed (secure-by-default): bila environment tidak mengonfigurasi
 *    `SMARTDOOR_API_KEY` (kosong/undefined), SEMUA nilai `provided` ditolak.
 *
 * Catatan: `isValidApiKey` menerima `env` yang dapat diinjeksikan (argumen
 * kedua), sehingga uji ini tidak memutasi `process.env` — cukup memberikan
 * objek env kustom `{ SMARTDOOR_API_KEY: configured }`.
 *
 * Validates: Requirements 7.3, 7.4
 */

// `describe`/`it`/`expect` tersedia sebagai global (vitest.config.js:
// `globals: true`). Vitest melarang `require('vitest')` di modul CommonJS,
// jadi kita mengandalkan global tersebut — konsisten dengan konfigurasi proyek.
const fc = require('fast-check');

const { isValidApiKey, API_KEY_ENV } = require('../src/middleware/apiKey');

/** Jumlah iterasi minimum per properti (>= 100 sesuai instruksi tugas). */
const NUM_RUNS = 300;

/** API_Key terkonfigurasi: string non-kosong sembarang. */
const configuredKeyArb = fc.string({ minLength: 1 });

/**
 * Nilai `provided` sembarang: string (mungkin kosong). Dibentuk agar jalur
 * ACCEPT ikut teruji — kadang mengumpankan kembali kunci terkonfigurasi,
 * kadang nilai acak (sangat mungkin berbeda), kadang kosong.
 *
 * @param {string} configured
 * @returns {import('fast-check').Arbitrary<string>}
 */
function providedArb(configured) {
  return fc.oneof(
    fc.constant(configured), // jalur ACCEPT: cocok persis
    fc.string(), // acak (mungkin beda, mungkin kosong)
    fc.constant('') // eksplisit kosong
  );
}

/**
 * Oracle independen dari implementasi: autentikasi diterima iff env
 * mengonfigurasi kunci non-kosong DAN `provided` string non-kosong yang sama
 * persis dengan kunci terkonfigurasi.
 *
 * @param {unknown} provided
 * @param {string} configured nilai `SMARTDOOR_API_KEY` di env (string).
 * @returns {boolean}
 */
function expectedValid(provided, configured) {
  const hasConfigured = typeof configured === 'string' && configured.length > 0;
  const providedOk = typeof provided === 'string' && provided.length > 0;
  return hasConfigured && providedOk && provided === configured;
}

describe('Feature: smart-door-kos-esp32, Property 11: Autentikasi menerima iff API_Key valid', () => {
  it('diterima iff provided string non-kosong & cocok persis dengan API_Key terkonfigurasi; selain itu ditolak', () => {
    fc.assert(
      fc.property(configuredKeyArb, (configured) => {
        const env = { [API_KEY_ENV]: configured };
        return fc.assert(
          fc.property(providedArb(configured), (provided) => {
            const expected = expectedValid(provided, configured);
            const actual = isValidApiKey(provided, env);
            expect(actual).toBe(expected);
          }),
          { numRuns: NUM_RUNS }
        );
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('kecocokan persis diterima (jalur ACCEPT)', () => {
    fc.assert(
      fc.property(configuredKeyArb, (configured) => {
        const env = { [API_KEY_ENV]: configured };
        expect(isValidApiKey(configured, env)).toBe(true);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('ketidakcocokan apa pun ditolak', () => {
    fc.assert(
      fc.property(
        configuredKeyArb,
        fc.string(),
        (configured, provided) => {
          fc.pre(provided !== configured);
          const env = { [API_KEY_ENV]: configured };
          expect(isValidApiKey(provided, env)).toBe(false);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('provided kosong/undefined/non-string ditolak meski env terkonfigurasi', () => {
    fc.assert(
      fc.property(
        configuredKeyArb,
        fc.oneof(
          fc.constant(''),
          fc.constant(undefined),
          fc.constant(null),
          fc.integer(),
          fc.boolean()
        ),
        (configured, provided) => {
          const env = { [API_KEY_ENV]: configured };
          expect(isValidApiKey(provided, env)).toBe(false);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('fail-closed: tanpa SMARTDOOR_API_KEY terkonfigurasi, SEMUA provided ditolak', () => {
    fc.assert(
      fc.property(
        // env tanpa konfigurasi kunci: kosong atau undefined.
        fc.oneof(fc.constant({}), fc.constant({ [API_KEY_ENV]: '' }), fc.constant({ [API_KEY_ENV]: undefined })),
        fc.string(),
        (env, provided) => {
          expect(isValidApiKey(provided, env)).toBe(false);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
