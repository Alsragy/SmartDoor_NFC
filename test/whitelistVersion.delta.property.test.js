'use strict';

/**
 * Property-based test — Smart Door KOS ESP32.
 *
 * Feature: smart-door-kos-esp32, Property 7: Delta sync merekonstruksi state server
 *
 * Memverifikasi sifat universal rekonstruksi delta-sync
 * (`whitelistVersion.computeDelta` + `applyDelta`):
 *
 *   Untuk sembarang himpunan kartu server (tiap kartu: uid unik, key_version,
 *   status ∈ CARD_STATUS, expired_at, db_version) dan sembarang snapshot lokal
 *   yang lebih lama (tampilan sub-himpunan / versi lebih tua dari server),
 *   maka:
 *       delta  = computeDelta(localVersion, serverCards)
 *       result = applyDelta(localSnapshot, delta)
 *   menghasilkan snapshot yang `db_hash`-nya IDENTIK dengan
 *   `dbHash(activeCards(serverCards))` — yakni hasil penerapan delta
 *   merekonstruksi snapshot aktif server.
 *
 * Model snapshot lokal "lebih lama": berisi kartu-kartu AKTIF server yang
 * `db_version <= localVersion` (kartu yang sudah dikenal firmware & belum
 * berubah sejak `localVersion`). Kartu dengan `db_version > localVersion`
 * (baik berubah/aktif maupun dicabut) dikirim lewat delta sehingga firmware
 * merekonstruksi state server terbaru. Statuses divariasikan agar sebagian
 * kartu REVOKED/UNPROVISIONED (removed) dan sebagian aktif.
 *
 * `describe`/`it`/`expect` tersedia sebagai global (vitest.config.js:
 * `globals: true`). Vitest v5 melarang `require('vitest')` di modul CommonJS,
 * jadi kita mengandalkan global tersebut — konsisten dengan proyek.
 *
 * Validates: Requirements 4.3
 */

const fc = require('fast-check');

const {
  computeDelta,
  applyDelta,
  dbHash,
  activeCards,
  isRemoved,
} = require('../src/services/whitelistVersion');
const { CARD_STATUS_VALUES } = require('../src/constants');

/** Jumlah iterasi minimum per properti (>= 100 sesuai instruksi tugas). */
const NUM_RUNS = 300;

/** Status kartu: salah satu dari seluruh status valid (varian REVOKED dsb). */
const statusArb = fc.constantFrom(...CARD_STATUS_VALUES);

/** expired_at sebagai epoch-ms, ATAU null (kartu tanpa masa berlaku). */
const expiredAtArb = fc.oneof(
  fc.constant(null),
  fc.integer({ min: 0, max: 2_000_000_000_000 })
);

/**
 * Generator himpunan kartu server dengan uid UNIK per set: indeks dipetakan
 * ke uid "CARD-<i>". Tiap kartu memiliki key_version, status bervariasi,
 * expired_at, dan db_version (>= 1 agar delta dari localVersion 0 mengirim
 * semua kartu bila diperlukan).
 */
const serverCardsArb = fc
  .array(
    fc.record({
      key_version: fc.integer({ min: 0, max: 50 }),
      status: statusArb,
      expired_at: expiredAtArb,
      db_version: fc.integer({ min: 1, max: 1000 }),
    }),
    { minLength: 0, maxLength: 12 }
  )
  .map((cards) =>
    cards.map((card, i) => ({
      uid: `CARD-${i}`, // uid unik dalam set
      key_version: card.key_version,
      status: card.status,
      expired_at: card.expired_at,
      db_version: card.db_version,
    }))
  );

describe('Feature: smart-door-kos-esp32, Property 7: Delta sync merekonstruksi state server', () => {
  it('applyDelta(localSnapshot, computeDelta(localVersion, serverCards)).db_hash === dbHash(activeCards(serverCards))', () => {
    fc.assert(
      fc.property(serverCardsArb, fc.integer({ min: 0, max: 1000 }), (serverCards, localVersion) => {
        // Snapshot lokal "lebih lama": kartu AKTIF server yang sudah dikenal
        // firmware pada localVersion (db_version <= localVersion) dan belum
        // berubah sejak itu. Kartu dengan db_version > localVersion dikirim
        // via delta.
        const localSnapshot = {
          db_version: localVersion,
          db_hash: dbHash(
            activeCards(serverCards).filter(
              (card) => Number(card.db_version) <= localVersion
            )
          ),
          cards: serverCards.filter(
            (card) => !isRemoved(card) && Number(card.db_version) <= localVersion
          ),
        };

        const delta = computeDelta(localVersion, serverCards);
        const result = applyDelta(localSnapshot, delta);

        const serverActiveHash = dbHash(activeCards(serverCards));

        // Rekonstruksi: hash hasil apply == hash snapshot aktif server.
        expect(result.db_hash).toBe(serverActiveHash);
        // Konsistensi internal: delta.db_hash juga acuan yang sama.
        expect(result.db_hash).toBe(delta.db_hash);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Full sync (localVersion 0, snapshot lokal kosong) merekonstruksi penuh state server', () => {
    fc.assert(
      fc.property(serverCardsArb, (serverCards) => {
        const localSnapshot = { db_version: 0, db_hash: dbHash([]), cards: [] };

        const delta = computeDelta(0, serverCards);
        const result = applyDelta(localSnapshot, delta);

        expect(result.db_hash).toBe(dbHash(activeCards(serverCards)));
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
