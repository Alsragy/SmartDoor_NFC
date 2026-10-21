// ============================================================================
// offline_log.h — Serialisasi & idempotensi Offline_Log_Queue (port C++17).
//
// Smart Door KOS ESP32 — modul logika MURNI & portabel (tanpa Arduino.h,
// tanpa I/O). Paritas dengan referensi JS server `src/services/offlineLog.js`
// sehingga server & firmware memakai aturan serialisasi, pruning ber-ACK, dan
// deduplikasi idempotency yang IDENTIK.
//
// Lihat design.md: Data Models "offline_logs.jsonl" (append-only, satu JSON
// per baris — tahan korupsi parsial) dan "Alur Delta Sync" (hapus entri
// ber-ACK), serta "Desain Idempotency Key untuk Ingest Offline-Log".
//
// Model event log:
//   {
//     "id":            "dev01-000017",   // idempotency key = deviceId + "-" + counter
//     "ts":            "2025-06-18T09:12:03Z",
//     "uid":           "04A2B3C4D5",
//     "result":        "GRANT" | "DENY",
//     "sync_type":     "CACHED_OFFLINE",
//     "ts_unverified": 0 | 1             // opsional (Req 5.5)
//   }
//
// Idempotency: server INSERT ... ON CONFLICT(idempotency_key) DO NOTHING
// (Req 19.3); ACK mengembalikan daftar id tersimpan sehingga firmware hanya
// menghapus entri yang pasti ter-ACK (Req 6.3).
//
// Counter idempotency: `next(counter) -> "<deviceId>-<counter zero-pad>"`.
// Logika counter MURNI & injectable; persistensi ke LittleFS adalah Task 24.
//
// JSON memakai ArduinoJson (berjalan di host via [env:native]).
//
// _Requirements: 5.1, 6.3, 6.4_
// ============================================================================
#ifndef SMARTDOOR_OFFLINE_LOG_H
#define SMARTDOOR_OFFLINE_LOG_H

#include <cstdint>
#include <string>
#include <vector>

namespace smartdoor {
namespace offline_log {

/**
 * Event log akses. Field opsional diwakili flag `has_*` agar round-trip
 * (serialize/parse) tidak menambah field yang memang tidak diset (paritas
 * perilaku `ts_unverified` di offlineLog.js).
 */
struct LogEvent {
  std::string id;         // idempotency key (field kanonik)
  std::string ts;         // ISO-8601 UTC
  std::string uid;        // UID kartu
  std::string result;     // "GRANT" | "DENY"
  std::string sync_type;  // mis. "CACHED_OFFLINE"

  bool has_ts_unverified = false;  // true bila field ts_unverified diset
  int ts_unverified = 0;           // 0 | 1 (Req 5.5)
};

// --------------------------------------------------------------------------
// Identitas
// --------------------------------------------------------------------------

/**
 * Ambil kunci identitas (idempotency key). Field kanonik adalah `id`.
 * Mengembalikan string kosong bila event tidak memiliki id.
 */
std::string identityKey(const LogEvent& event);

// --------------------------------------------------------------------------
// Serialisasi JSONL
// --------------------------------------------------------------------------

/**
 * Serialkan satu event menjadi satu baris JSONL (DIJAMIN tanpa newline).
 * Round-trip: serialize -> parse menghasilkan event setara (Property 8).
 * @param event event log.
 * @param out   baris JSON hasil (tanpa '\n').
 * @return true bila sukses (false bila hasil tak terduga memuat newline).
 */
bool serialize(const LogEvent& event, std::string& out);

/** Varian yang mengembalikan string (string kosong bila gagal). */
std::string serialize(const LogEvent& event);

/**
 * Parse satu baris JSONL menjadi event. Baris boleh diakhiri whitespace/newline.
 * @return true bila baris adalah objek JSON valid.
 */
bool parse(const std::string& line, LogEvent& out);

// --------------------------------------------------------------------------
// Pruning ber-ACK & deduplikasi
// --------------------------------------------------------------------------

/**
 * Buang dari antrean tepat entri yang id-nya ber-ACK. Mengembalikan antrean
 * BARU (urutan dipertahankan). Entri tanpa id selalu dipertahankan.
 * Property 9: hasil = antrean awal − id ber-ACK, tepat. (Req 6.3)
 */
std::vector<LogEvent> pruneAcked(const std::vector<LogEvent>& queue,
                                 const std::vector<std::string>& ackedIds);

/**
 * Deduplikasi berdasarkan id, mempertahankan kemunculan PERTAMA tiap key unik.
 * Entri tanpa id tidak pernah dianggap duplikat (selalu dipertahankan).
 */
std::vector<LogEvent> dedupeByKey(const std::vector<LogEvent>& logs);

// --------------------------------------------------------------------------
// Counter idempotency (murni & injectable; persistensi = Task 24)
// --------------------------------------------------------------------------

/**
 * Counter monotonik persisten untuk idempotency key.
 * `deviceId` tetap; `counter` dinaikkan tiap log; `width` = lebar zero-pad
 * (default 6, cocok dengan contoh "dev01-000017").
 *
 * CATATAN: struct ini hanya MODEL logika. Persistensi nilai `counter` ke
 * LittleFS/NVS ditangani Task 24; di sini murni agar dapat di-test di host.
 */
struct IdempotencyCounter {
  std::string deviceId;
  uint64_t counter = 0;
  int width = 6;
};

/**
 * Bentuk id dari deviceId + counter (zero-padded) TANPA menaikkan counter.
 * Contoh: deviceId="dev01", counter=17, width=6 -> "dev01-000017".
 */
std::string formatId(const std::string& deviceId, uint64_t counter,
                     int width = 6);

/**
 * Hasilkan id BERIKUTNYA: menaikkan `counter` lalu mengembalikan id baru.
 * Memutasi `counter.counter` (pemanggil bertanggung jawab mem-persist nilai
 * baru — Task 24).
 *
 * Nilai pertama yang dikembalikan untuk counter awal 0 adalah untuk counter 1
 * (mis. "dev01-000001"), sehingga id tidak pernah memakai counter 0.
 */
std::string next(IdempotencyCounter& counter);

/**
 * Varian murni tanpa mutasi: dari nilai counter saat ini, kembalikan pasangan
 * {id berikut, nilai counter berikut} agar pemanggil dapat mem-persist dulu
 * sebelum memakai (pola write-ahead untuk tahan reboot — Req 6.4).
 */
struct NextId {
  std::string id;
  uint64_t nextCounter = 0;
};
NextId peekNext(const std::string& deviceId, uint64_t currentCounter,
                int width = 6);

}  // namespace offline_log
}  // namespace smartdoor

#endif  // SMARTDOOR_OFFLINE_LOG_H
