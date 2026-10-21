'use strict';

/**
 * Versioning & Hash Kartu untuk Delta Sync — Smart Door KOS ESP32.
 *
 * Modul logika MURNI (tanpa I/O, jaringan, atau state tersembunyi). Menjadi
 * referensi portabel bersama antara Web_Server (sumber kebenaran data kartu)
 * dan lapisan delta-sync firmware (syncTask), sehingga kedua sisi menghitung
 * `card_hash`/`db_hash` serta menerapkan delta dengan aturan yang IDENTIK.
 *
 * Model (lihat design.md "Versioning & Hash Kartu untuk Delta Sync", Req 4.3):
 *   - Tiap kartu punya `db_version` monotonik. Setiap perubahan kartu
 *     (provisioning/suspend/revoke/update) menaikkan `db_version` dan
 *     memperbarui `card_hash`.
 *   - `card_hash = SHA-256(serialisasi kanonik field relevan kartu)`.
 *     Field relevan: uid, key_version, status, expired_at (Data Models).
 *   - `db_hash = SHA-256(daftar card_hash terurut berdasar uid)`.
 *   - Delta: `changed` = kartu dengan `db_version > since_version` yang MASIH
 *     aktif di whitelist (status bukan REVOKED); `removed` = daftar `uid`
 *     kartu yang dicabut/dihapus (status REVOKED) dengan `db_version` lebih
 *     baru. `db_version`/`db_hash` baru ikut dikirim agar firmware dapat
 *     memverifikasi konsistensi setelah menerapkan delta (Property 7).
 *
 * Snapshot whitelist (bentuk kanonik modul ini):
 *   {
 *     db_version: <number>,
 *     db_hash:    "sha256:<hex>",
 *     cards:      [ { uid, key_version, status, expired_at, db_version }, ... ]
 *   }
 * Snapshot hanya memuat kartu AKTIF di firmware (REVOKED selalu dihapus total
 * dari array — Req 10.2). `db_hash` karena itu dihitung atas kartu aktif saja.
 *
 * Properti terkait (design.md):
 *   - Property 6: Pencabutan menghapus akses tepat sasaran (uid yang dihapus
 *     → tidak lagi ada di snapshot; uid lain tidak berubah).
 *   - Property 7: Delta sync merekonstruksi state server (apply delta pada
 *     snapshot lokal → `db_hash` identik dengan snapshot server).
 *
 * _Requirements: 4.3_
 */

const crypto = require('crypto');

const { CARD_STATUS } = require('../constants');

/** Prefiks representasi hash (konsisten dengan contoh whitelist.json). */
const HASH_PREFIX = 'sha256:';

/** Pemisah antar-field pada serialisasi kanonik card_hash (tak mungkin di uid). */
const FIELD_SEPARATOR = '\u001f'; // ASCII Unit Separator (US)

/**
 * Normalisasi sebuah nilai field untuk serialisasi kanonik.
 * null/undefined → string kosong agar stabil & deterministik.
 * @param {*} value
 * @returns {string}
 */
function canonicalField(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

/**
 * Serialisasi kanonik field relevan sebuah kartu (urutan field tetap).
 * Urutan: uid, key_version, status, expired_at. Deterministik lintas sistem.
 * @param {object} card entri kartu.
 * @returns {string} string kanonik untuk di-hash.
 */
function canonicalizeCard(card) {
  if (!card || typeof card !== 'object') {
    throw new TypeError('canonicalizeCard: card harus berupa objek');
  }
  return [
    canonicalField(card.uid),
    canonicalField(card.key_version),
    canonicalField(card.status),
    canonicalField(card.expired_at),
  ].join(FIELD_SEPARATOR);
}

/**
 * Hitung `card_hash` sebuah kartu: SHA-256 atas serialisasi kanonik field
 * relevan (uid, key_version, status, expired_at), dikembalikan sebagai hex
 * ber-prefiks `sha256:`.
 *
 * Deterministik: isi kartu yang sama → hash sama; perubahan salah satu field
 * relevan → hash berbeda (mendasari kenaikan db_version saat kartu berubah).
 *
 * @param {object} card entri kartu.
 * @returns {string} mis. "sha256:a3f1...".
 */
function cardHash(card) {
  const canonical = canonicalizeCard(card);
  const hex = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return HASH_PREFIX + hex;
}

/**
 * Hitung `db_hash` sebuah daftar kartu: SHA-256 atas daftar `card_hash` yang
 * DIURUTKAN berdasarkan `uid` (determinisme tak bergantung urutan input),
 * dikembalikan sebagai hex ber-prefiks `sha256:`.
 *
 * Catatan: db_hash mencerminkan snapshot kartu AKTIF. Pemanggil bertanggung
 * jawab memastikan kartu REVOKED tidak disertakan (lihat {@link activeCards}).
 *
 * @param {Array<object>} cards daftar kartu.
 * @returns {string} mis. "sha256:9c2b...".
 */
function dbHash(cards) {
  if (!Array.isArray(cards)) {
    throw new TypeError('dbHash: cards harus berupa array');
  }
  const hashes = cards
    .map((card) => ({ uid: canonicalField(card.uid), hash: cardHash(card) }))
    .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
    .map((entry) => entry.hash);

  const hex = crypto
    .createHash('sha256')
    .update(hashes.join(FIELD_SEPARATOR), 'utf8')
    .digest('hex');
  return HASH_PREFIX + hex;
}

/**
 * Apakah sebuah kartu dianggap "dihapus" dari whitelist firmware.
 * Kartu REVOKED dihapus total (Req 10.2). UNPROVISIONED juga tidak layak
 * ada di whitelist aktif (provisioning belum selesai) sehingga diperlakukan
 * sebagai removed agar tidak pernah masuk snapshot firmware.
 * @param {object} card
 * @returns {boolean}
 */
function isRemoved(card) {
  if (!card || typeof card !== 'object') {
    return true;
  }
  return (
    card.status === CARD_STATUS.REVOKED ||
    card.status === CARD_STATUS.UNPROVISIONED
  );
}

/**
 * Saring daftar kartu menjadi hanya kartu AKTIF di whitelist firmware
 * (membuang REVOKED/UNPROVISIONED). Tidak memutasi input.
 * @param {Array<object>} cards
 * @returns {Array<object>}
 */
function activeCards(cards) {
  if (!Array.isArray(cards)) {
    throw new TypeError('activeCards: cards harus berupa array');
  }
  return cards.filter((card) => !isRemoved(card));
}

/**
 * Konversi aman sebuah nilai `db_version` ke angka; default 0.
 * @param {*} value
 * @returns {number}
 */
function toVersion(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Bangun delta whitelist sejak `sinceVersion` dari daftar kartu server.
 *
 * Aturan:
 *   - `changed`  : kartu dengan `db_version > sinceVersion` yang MASIH aktif
 *                  (bukan REVOKED/UNPROVISIONED) → firmware meng-upsert.
 *   - `removed`  : daftar `uid` kartu yang `db_version > sinceVersion` dan
 *                  berstatus removed (REVOKED/UNPROVISIONED) → firmware
 *                  menghapus entri uid tsb. (Req 10.2).
 *   - `db_version`: `db_version` maksimum di seluruh `serverCards` (monotonik).
 *   - `db_hash`  : hash snapshot kartu AKTIF server (acuan verifikasi, Property 7).
 *
 * `sinceVersion` null/undefined diperlakukan sebagai 0 (full delta: semua
 * kartu dikirim).
 *
 * @param {number|null|undefined} sinceVersion versi lokal firmware saat ini.
 * @param {Array<object>} serverCards seluruh kartu di sisi server.
 * @returns {{ changed: Array<object>, removed: Array<string>, db_version: number, db_hash: string }}
 */
function computeDelta(sinceVersion, serverCards) {
  if (!Array.isArray(serverCards)) {
    throw new TypeError('computeDelta: serverCards harus berupa array');
  }
  const since = toVersion(sinceVersion);

  const changed = [];
  const removed = [];
  let maxVersion = since;

  for (const card of serverCards) {
    const version = toVersion(card.db_version);
    if (version > maxVersion) {
      maxVersion = version;
    }
    if (version <= since) {
      continue; // tidak berubah sejak versi lokal
    }
    if (isRemoved(card)) {
      removed.push(canonicalField(card.uid));
    } else {
      changed.push(card);
    }
  }

  return {
    changed,
    removed,
    db_version: maxVersion,
    db_hash: dbHash(activeCards(serverCards)),
  };
}

/**
 * Ekstrak array kartu dari sebuah snapshot yang boleh berbentuk:
 *   - array kartu langsung, ATAU
 *   - objek `{ cards, db_version, db_hash }`.
 * Mengembalikan SALINAN array (tidak memutasi input).
 * @param {Array<object>|{cards?: Array<object>}} snapshot
 * @returns {Array<object>}
 */
function extractCards(snapshot) {
  if (Array.isArray(snapshot)) {
    return snapshot.slice();
  }
  if (snapshot && typeof snapshot === 'object' && Array.isArray(snapshot.cards)) {
    return snapshot.cards.slice();
  }
  if (snapshot == null) {
    return [];
  }
  throw new TypeError('applyDelta: snapshot harus array kartu atau { cards }');
}

/**
 * Terapkan sebuah delta ke snapshot lokal, menghasilkan snapshot BARU.
 *
 * Langkah:
 *   1. Upsert setiap kartu di `delta.changed` berdasarkan `uid` (ganti bila
 *      ada, tambah bila belum) — kartu REVOKED yang mungkin terselip disaring.
 *   2. Hapus setiap `uid` di `delta.removed` (Req 10.2, Property 6).
 *   3. Hitung ulang `db_hash` atas kartu aktif hasil akhir; set `db_version`
 *      ke `delta.db_version`.
 *
 * Bila delta konsisten dengan snapshot server, `db_hash` hasil akan IDENTIK
 * dengan `delta.db_hash` (Property 7). Tidak memutasi `localSnapshot`.
 *
 * @param {Array<object>|{cards: Array<object>, db_version?: number, db_hash?: string}} localSnapshot
 * @param {{ changed?: Array<object>, removed?: Array<string>, db_version?: number, db_hash?: string }} delta
 * @returns {{ cards: Array<object>, db_version: number, db_hash: string }} snapshot baru.
 */
function applyDelta(localSnapshot, delta) {
  if (!delta || typeof delta !== 'object') {
    throw new TypeError('applyDelta: delta harus berupa objek');
  }

  const cards = extractCards(localSnapshot);
  const changed = Array.isArray(delta.changed) ? delta.changed : [];
  const removed = Array.isArray(delta.removed) ? delta.removed : [];

  // Index uid -> posisi untuk upsert O(1) amortized, menjaga urutan insert.
  const indexByUid = new Map();
  cards.forEach((card, i) => {
    indexByUid.set(canonicalField(card.uid), i);
  });

  // 1) Upsert kartu changed (abaikan yang ternyata removed demi konsistensi).
  for (const card of changed) {
    if (isRemoved(card)) {
      continue;
    }
    const uid = canonicalField(card.uid);
    if (indexByUid.has(uid)) {
      cards[indexByUid.get(uid)] = card;
    } else {
      indexByUid.set(uid, cards.length);
      cards.push(card);
    }
  }

  // 2) Hapus uid yang dicabut.
  const removedSet = new Set(removed.map((uid) => canonicalField(uid)));
  const nextCards = removedSet.size === 0
    ? cards
    : cards.filter((card) => !removedSet.has(canonicalField(card.uid)));

  // 3) Hitung ulang hash & versi.
  const active = activeCards(nextCards);
  return {
    cards: nextCards,
    db_version: toVersion(delta.db_version),
    db_hash: dbHash(active),
  };
}

module.exports = {
  HASH_PREFIX,
  cardHash,
  dbHash,
  computeDelta,
  applyDelta,
  activeCards,
  isRemoved,
  canonicalizeCard,
};
