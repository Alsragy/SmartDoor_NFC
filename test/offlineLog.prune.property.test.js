'use strict';

/**
 * Property-based test — Smart Door KOS ESP32.
 *
 * Feature: smart-door-kos-esp32, Property 9: Pengosongan antrean hanya untuk
 * entri ber-ACK.
 *
 * Memverifikasi sifat universal dari `offlineLog.pruneAcked`:
 *  - Untuk sembarang antrean event log (tiap entri ber-id/idempotency_key unik)
 *    dan sembarang subset id yang di-ACK (sebagian ada di antrean, sebagian
 *    mungkin tidak), hasil pembersihan sama dengan antrean awal DIKURANGI tepat
 *    entri yang id-nya di-ACK — yakni:
 *        pruneAcked(queue, ackedIds)
 *          === queue.filter((e) => !ackedSet.has(identityKey(e)))
 *    dengan urutan dipertahankan, dan input `queue` TIDAK dimutasi.
 *
 * Kasus khusus yang turut diuji eksplisit:
 *  - ackedIds kosong  → antrean dikembalikan tak berubah (sebagai salinan).
 *  - semua id ber-ACK → hasil kosong.
 *
 * Validates: Requirements 6.2, 6.3
 */

// `describe`/`it`/`expect` tersedia sebagai global (vitest.config.js:
// `globals: true`). Vitest v5 melarang `require('vitest')` di modul CommonJS,
// jadi kita mengandalkan global tersebut — konsisten dengan konfigurasi proyek.
const fc = require('fast-check');

const { pruneAcked, identityKey } = require('../src/services/offlineLog');

/** Jumlah iterasi minimum per properti (>= 100 sesuai instruksi tugas). */
const NUM_RUNS = 300;

/**
 * Arbitrary antrean event log dengan id/idempotency_key UNIK.
 *
 * Kita hasilkan sekumpulan id unik lebih dulu (via `fc.uniqueArray`), lalu
 * memetakan tiap id menjadi event log berbentuk realistis. Keunikan id penting
 * agar semantik "hasil = antrean − id ber-ACK" tidak rancu oleh entri kembar.
 */
const idArb = fc
  .tuple(
    fc.constantFrom('dev01', 'dev02', 'dev03'),
    fc.integer({ min: 0, max: 999999 })
  )
  .map(([dev, n]) => `${dev}-${String(n).padStart(6, '0')}`);

const eventFromId = (id) =>
  fc
    .record({
      ts: fc.constant('2025-06-18T09:12:03Z'),
      uid: fc
        .array(fc.constantFrom(...'0123456789ABCDEF'.split('')), { minLength: 8, maxLength: 10 })
        .map((chars) => chars.join('')),
      result: fc.constantFrom('GRANT', 'DENY'),
      sync_type: fc.constant('CACHED_OFFLINE'),
    })
    .map((rest) => ({ id, ...rest }));

/** Antrean: array event dengan id unik (boleh kosong). */
const queueArb = fc
  .uniqueArray(idArb, { minLength: 0, maxLength: 30 })
  .chain((ids) => (ids.length === 0 ? fc.constant([]) : fc.tuple(...ids.map(eventFromId))))
  .map((arr) => Array.from(arr));

/**
 * Pasangan (queue, ackedIds) di mana ackedIds adalah subset acak dari id yang
 * ADA di antrean, DITAMBAH beberapa id acak yang mungkin TIDAK ada di antrean.
 * Dengan begitu kita menguji baik id yang cocok maupun id asing.
 */
const queueAndAckedArb = queueArb.chain((queue) => {
  const presentIds = queue.map((e) => e.id);
  const subsetArb =
    presentIds.length === 0
      ? fc.constant([])
      : fc.subarray(presentIds, { minLength: 0, maxLength: presentIds.length });
  // Id "asing" yang kemungkinan besar tidak ada di antrean.
  const foreignArb = fc.array(idArb, { minLength: 0, maxLength: 10 });
  return fc.tuple(fc.constant(queue), subsetArb, foreignArb).map(([q, subset, foreign]) => {
    // Gabungkan subset present + id asing lalu acak melalui Set → array.
    const ackedIds = Array.from(new Set([...subset, ...foreign]));
    return { queue: q, ackedIds };
  });
});

/**
 * Ekspektasi dihitung INDEPENDEN dari implementasi: antrean awal disaring
 * dengan membuang entri yang identitasnya ada di set ber-ACK.
 */
function expectedPrune(queue, ackedIds) {
  const ackedSet = new Set(ackedIds);
  return queue.filter((e) => !ackedSet.has(identityKey(e)));
}

describe('Feature: smart-door-kos-esp32, Property 9: Pengosongan antrean hanya untuk entri ber-ACK', () => {
  it('hasil = antrean awal − id ber-ACK (urutan terjaga) dan input tidak dimutasi', () => {
    fc.assert(
      fc.property(queueAndAckedArb, ({ queue, ackedIds }) => {
        const beforeLength = queue.length;
        const beforeSnapshot = queue.slice();

        const expected = expectedPrune(queue, ackedIds);
        const actual = pruneAcked(queue, ackedIds);

        // Hasil tepat = antrean awal dikurangi entri ber-ACK, urutan terjaga.
        expect(actual).toEqual(expected);

        // Tidak ada entri ber-ACK yang tersisa.
        const ackedSet = new Set(ackedIds);
        for (const e of actual) {
          expect(ackedSet.has(identityKey(e))).toBe(false);
        }

        // Input `queue` tidak dimutasi (panjang & isi tidak berubah).
        expect(queue.length).toBe(beforeLength);
        expect(queue).toEqual(beforeSnapshot);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('ackedIds kosong → antrean dikembalikan tak berubah namun sebagai salinan (bukan referensi sama)', () => {
    fc.assert(
      fc.property(queueArb, (queue) => {
        const beforeSnapshot = queue.slice();

        const actual = pruneAcked(queue, []);

        // Isi identik dengan antrean awal.
        expect(actual).toEqual(queue);
        // Namun merupakan salinan (tidak memutasi input).
        expect(actual).not.toBe(queue);
        expect(queue).toEqual(beforeSnapshot);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('semua id ber-ACK → hasil kosong', () => {
    fc.assert(
      fc.property(queueArb, (queue) => {
        const allIds = queue.map((e) => e.id);

        const actual = pruneAcked(queue, allIds);

        expect(actual).toEqual([]);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
