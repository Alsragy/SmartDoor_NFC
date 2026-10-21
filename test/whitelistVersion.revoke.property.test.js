'use strict';

/**
 * Property-based test — Smart Door KOS ESP32.
 *
 * Feature: smart-door-kos-esp32, Property 6: Pencabutan menghapus akses tepat sasaran
 *
 * Memverifikasi sifat universal dari pencabutan (revoke) pada lapisan whitelist
 * (`whitelistVersion.applyDelta`):
 *
 *   Untuk sembarang snapshot whitelist (array kartu AKTIF dengan `uid` unik) dan
 *   sembarang `uid` sasaran yang ADA di snapshot, menerapkan delta yang menghapus
 *   `uid` tersebut — applyDelta(snapshot, { changed: [], removed: [uid], ... }) —
 *   menghasilkan snapshot baru di mana:
 *     (a) `uid` sasaran TIDAK LAGI ada (sehingga keputusan akses untuk kartu
 *         tsb. — yang kini tak ada di whitelist — adalah DENY), DAN
 *     (b) SETIAP `uid` lain tetap ada dan kartunya TIDAK berubah (objek & field
 *         identik, by reference).
 *
 * Catatan: `decide` adalah fungsi murni berbasis whitelist lokal. Kartu yang
 * sudah dihapus dari snapshot tidak lagi tersedia sebagai input bagi `decide`,
 * sehingga keputusannya DENY (UNKNOWN_CARD) — inilah efek "akses dicabut".
 *
 * Validates: Requirements 10.2, 10.3
 */

// `describe`/`it`/`expect` tersedia sebagai global (vitest.config.js:
// `globals: true`). Vitest v5 melarang `require('vitest')` di modul CommonJS,
// jadi kita mengandalkan global tersebut — konsisten dengan konfigurasi proyek.
const fc = require('fast-check');

const { applyDelta } = require('../src/services/whitelistVersion');
const { decide, DECISION } = require('../src/services/accessDecision');
const { CARD_STATUS } = require('../src/constants');

/** Jumlah iterasi minimum per properti (>= 100 sesuai instruksi tugas). */
const NUM_RUNS = 300;

/**
 * Generator UID unik untuk membangun snapshot: array string tak-kosong yang
 * dijamin unik. UID disamakan dengan serialisasi kanonik modul (String(uid)).
 */
const uidArb = fc
  .string({ minLength: 1, maxLength: 12 })
  // Hindari pemisah kanonik internal modul agar uid stabil sebagai kunci.
  .filter((s) => !s.includes('\u001f'));

const uniqueUidsArb = fc.uniqueArray(uidArb, { minLength: 1, maxLength: 20 });

/**
 * Bangun sebuah kartu AKTIF deterministik untuk sebuah uid. Kartu dibuat ACTIVE
 * tanpa masa berlaku agar — bila masih ada di whitelist — berpotensi GRANT;
 * sehingga perbedaan GRANT/DENY benar-benar ditentukan oleh ada/tidaknya kartu.
 * @param {string} uid
 * @param {number} i indeks untuk memvariasikan field non-kunci.
 * @returns {object}
 */
function makeActiveCard(uid, i) {
  return {
    uid,
    key_version: (i % 5) + 1,
    status: CARD_STATUS.ACTIVE,
    expired_at: null,
    db_version: i + 1,
  };
}

/**
 * Arbitrary menghasilkan { cards, targetUid } di mana `targetUid` dijamin ADA
 * di `cards`, dan semua uid unik.
 */
const snapshotWithTargetArb = uniqueUidsArb.chain((uids) =>
  fc
    .integer({ min: 0, max: uids.length - 1 })
    .map((targetIndex) => ({
      cards: uids.map((uid, i) => makeActiveCard(uid, i)),
      targetUid: uids[targetIndex],
    }))
);

describe('Feature: smart-door-kos-esp32, Property 6: Pencabutan menghapus akses tepat sasaran', () => {
  it('hapus satu UID → UID itu absen (akses DENY); setiap UID lain tak berubah', () => {
    fc.assert(
      fc.property(snapshotWithTargetArb, ({ cards, targetUid }) => {
        const snapshot = {
          db_version: cards.length,
          db_hash: 'sha256:seed',
          cards,
        };

        const delta = {
          changed: [],
          removed: [targetUid],
          db_version: cards.length + 1,
          db_hash: 'sha256:after',
        };

        const next = applyDelta(snapshot, delta);
        const nextByUid = new Map(next.cards.map((c) => [c.uid, c]));

        // (a) UID sasaran absen dari snapshot hasil.
        expect(nextByUid.has(targetUid)).toBe(false);

        // (a') Keputusan akses untuk UID yang dicabut adalah DENY: kartu tsb.
        // tidak lagi tersedia di whitelist lokal → tidak dapat di-GRANT.
        const revokedCard = nextByUid.get(targetUid); // undefined (sudah hapus)
        const decision = decide(revokedCard, Date.now(), true);
        expect(decision.result).toBe(DECISION.DENY);

        // (b) Setiap UID lain tetap ada & kartunya identik (by reference).
        for (const original of cards) {
          if (original.uid === targetUid) continue;
          expect(nextByUid.has(original.uid)).toBe(true);
          // Objek yang sama persis (tak dimutasi / tak diganti).
          expect(nextByUid.get(original.uid)).toBe(original);
        }

        // Jumlah kartu berkurang tepat satu.
        expect(next.cards.length).toBe(cards.length - 1);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
