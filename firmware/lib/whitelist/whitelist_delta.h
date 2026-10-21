// ============================================================================
// whitelist_delta.h — Versioning & Hash Kartu untuk Delta Sync (port C++17).
//
// Smart Door KOS ESP32 — modul logika MURNI & portabel (tanpa Arduino.h,
// tanpa I/O, tanpa jaringan). Paritas dengan referensi JS server
// `src/services/whitelistVersion.js` sehingga Web_Server dan Firmware
// menghitung `card_hash`/`db_hash` dan menerapkan delta dengan aturan IDENTIK.
//
// Lihat design.md: "Versioning & Hash Kartu untuk Delta Sync" dan
// "Alur Delta Sync saat Pemulihan WiFi".
//
// Model (Req 4.3):
//   - `card_hash = sha256:(uid US key_version US status US expired_at)`
//     dengan US = ASCII Unit Separator (0x1F) sebagai pemisah field kanonik.
//   - `db_hash  = sha256:(join(card_hash kartu AKTIF terurut-uid, US))`.
//   - Snapshot firmware hanya memuat kartu AKTIF (REVOKED/UNPROVISIONED
//     dihapus total — Req 10.2); db_hash dihitung atas kartu aktif saja.
//
// Properti:
//   - Property 6: Pencabutan menghapus akses tepat sasaran.
//   - Property 7: Terapkan delta pada snapshot lokal → db_hash identik dengan
//     snapshot server bila konsisten.
//
// SHA-256 diabstraksikan di balik `Sha256Fn` (lihat sha256.h). Default memakai
// implementasi referensi portabel sehingga db_hash dapat dihitung penuh di
// host (Task 22.4). ESP32 boleh menyuntik mbedtls dengan tanda tangan sama.
//
// JSON memakai ArduinoJson (berjalan di host via [env:native]).
//
// _Requirements: 4.3_
// ============================================================================
#ifndef SMARTDOOR_WHITELIST_DELTA_H
#define SMARTDOOR_WHITELIST_DELTA_H

#include <cstdint>
#include <string>
#include <vector>

#include "sha256.h"

namespace smartdoor {
namespace whitelist {

/** Prefiks representasi hash (konsisten dengan whitelist.json). */
inline const char* hashPrefix() { return "sha256:"; }

/** Nilai string status kartu (paritas dengan constants.js CARD_STATUS). */
namespace status {
inline const char* kActive() { return "ACTIVE"; }
inline const char* kSuspended() { return "SUSPENDED"; }
inline const char* kRevoked() { return "REVOKED"; }
inline const char* kUnprovisioned() { return "UNPROVISIONED"; }
}  // namespace status

/**
 * Entri kartu kanonik. Field relevan untuk hash: uid, key_version, status,
 * expired_at. `db_version` dipakai untuk logika delta.
 *
 * Nilai yang "tidak diset" diwakili string kosong agar serialisasi kanonik
 * stabil & deterministik (paritas `canonicalField` di JS: null/undefined -> "").
 */
struct Card {
  std::string uid;
  std::string key_version;
  std::string status;
  std::string expired_at;
  int64_t db_version = 0;
};

/**
 * Snapshot whitelist (bentuk kanonik modul ini).
 * `cards` hanya memuat kartu AKTIF di firmware.
 */
struct Snapshot {
  int64_t db_version = 0;
  std::string db_hash;  // "sha256:<hex>"
  std::vector<Card> cards;
};

/**
 * Delta whitelist dari server (hasil GET /whitelist?since_version=...).
 *   - `changed`   : kartu yang di-upsert.
 *   - `removed`   : daftar uid yang dihapus (REVOKED/UNPROVISIONED).
 *   - `db_version`: versi baru (monotonik).
 *   - `db_hash`   : acuan verifikasi konsistensi (Property 7).
 */
struct Delta {
  std::vector<Card> changed;
  std::vector<std::string> removed;
  int64_t db_version = 0;
  std::string db_hash;  // "sha256:<hex>"
};

// --------------------------------------------------------------------------
// Primitif kanonik & hash
// --------------------------------------------------------------------------

/** Serialisasi kanonik field relevan sebuah kartu (uid US kv US status US exp). */
std::string canonicalizeCard(const Card& card);

/**
 * card_hash: "sha256:<hex>" atas serialisasi kanonik kartu.
 * @param card  kartu.
 * @param hashFn fungsi hash (default: referensi portabel).
 */
std::string cardHash(const Card& card,
                     const Sha256Fn& hashFn = referenceSha256Hex);

/**
 * db_hash: "sha256:<hex>" atas daftar card_hash yang DIURUTKAN berdasar uid.
 * Pemanggil bertanggung jawab menyertakan hanya kartu AKTIF (lihat
 * {@link activeCards}).
 */
std::string dbHash(const std::vector<Card>& cards,
                   const Sha256Fn& hashFn = referenceSha256Hex);

// --------------------------------------------------------------------------
// Klasifikasi & filter
// --------------------------------------------------------------------------

/** Apakah kartu dianggap "dihapus" dari whitelist firmware (REVOKED/UNPROVISIONED). */
bool isRemoved(const Card& card);

/** Salin hanya kartu AKTIF (buang REVOKED/UNPROVISIONED). Tidak memutasi input. */
std::vector<Card> activeCards(const std::vector<Card>& cards);

// --------------------------------------------------------------------------
// Delta
// --------------------------------------------------------------------------

/**
 * Terapkan delta ke snapshot lokal, menghasilkan snapshot BARU.
 * Langkah: upsert `changed` (abaikan yang removed) by uid, hapus `removed`,
 * lalu hitung ulang db_hash atas kartu aktif & set db_version = delta.db_version.
 *
 * Bila delta konsisten dengan server, `result.db_hash` == `delta.db_hash`
 * (Property 7). Tidak memutasi `localSnapshot`.
 */
Snapshot applyDelta(const Snapshot& localSnapshot, const Delta& delta,
                    const Sha256Fn& hashFn = referenceSha256Hex);

/**
 * Verifikasi konsistensi: apakah db_hash snapshot cocok dengan `expectedDbHash`
 * (biasanya `delta.db_hash` server). Perbandingan string penuh berikut prefiks.
 */
bool verifyDbHash(const Snapshot& snapshot, const std::string& expectedDbHash);

/**
 * Terapkan delta LALU verifikasi db_hash hasil terhadap `delta.db_hash`.
 * Mengembalikan true bila konsisten; `out` selalu diisi snapshot hasil apply
 * (walau verifikasi gagal) agar pemanggil dapat memutuskan (mis. fallback full
 * sync bila gagal).
 */
bool applyDeltaVerified(const Snapshot& localSnapshot, const Delta& delta,
                        Snapshot& out,
                        const Sha256Fn& hashFn = referenceSha256Hex);

// --------------------------------------------------------------------------
// (De)serialisasi JSON (ArduinoJson)
// --------------------------------------------------------------------------

/**
 * Parse objek JSON delta ({ changed, removed, db_version, db_hash }) menjadi
 * `Delta`. Mengembalikan true bila sukses. Toleran terhadap field hilang.
 */
bool parseDeltaJson(const std::string& json, Delta& out);

/**
 * Parse objek JSON snapshot whitelist ({ db_version, db_hash, cards }) menjadi
 * `Snapshot`. Mengembalikan true bila sukses.
 */
bool parseSnapshotJson(const std::string& json, Snapshot& out);

/** Serialkan `Snapshot` menjadi JSON whitelist.json ({ db_version, db_hash, cards }). */
std::string serializeSnapshotJson(const Snapshot& snapshot);

}  // namespace whitelist
}  // namespace smartdoor

#endif  // SMARTDOOR_WHITELIST_DELTA_H
