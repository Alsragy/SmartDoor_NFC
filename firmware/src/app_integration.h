// ============================================================================
// app_integration.h — Wiring Task 24 ke kerangka task (Task 23).
//
// Menyambungkan modul penyimpanan LittleFS (storage.h) dan strategi waktu RTC
// DS3231 + NTP (rtc_time.h) ke SEAM perangkat keras (`HardwareHooks`) yang
// didefinisikan di app_config.h dan dipanggil oleh task FreeRTOS (tasks.cpp).
//
// Peran tiap seam yang DIISI Task 24 (lihat app_config.h):
//   - NowIsoFn  nowIso        → rtc_time::nowIso8601Utc() (dipakai nfcReadTask
//                               untuk LogEvent.ts — Req 5.2/5.4).
//   - NtpSyncFn ntpSync       → rtc_time::syncRtcFromNtp() (dipanggil timeTask
//                               saat online — Req 5.3).
//   - EnqueueLogLineFn        → storage::appendLog(...) via parse baris JSONL
//                               (append-only ke offline_logs.jsonl — Req 5.1).
//
// Selain hook di jalur kritis, modul ini menyediakan helper STORAGE-BACKED
// untuk syncTask (Task 27.2) agar antrean offline & whitelist delta memakai
// LittleFS + lib portabel dengan paritas server:
//   - drainOfflineLogsForUpload() / confirmUploadedLogs()
//   - applyWhitelistDeltaJson() (parse delta JSON → applyDeltaVerified → persist)
//
// FIRMWARE-TARGET: bergantung pada storage/rtc_time (Arduino/ESP32). Tidak
// dibangun untuk [env:native].
//
// _Requirements: 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 5.5, 6.3_
// ============================================================================
#ifndef SMARTDOOR_APP_INTEGRATION_H
#define SMARTDOOR_APP_INTEGRATION_H

#include <string>
#include <vector>

#include "app_config.h"
#include "offline_log.h"
#include "storage.h"

namespace smartdoor {
namespace app {

// ---------------------------------------------------------------------------
// setupStorageAndTime — dipanggil dari setup() SEBELUM startTasks().
//   1. Mount LittleFS (storage::begin).
//   2. Muat config.json → isi `ctx.config` (lock/door timers, api_key, mqtt,
//      kredensial wifi ssid/password, whitelist_url, device_id) — Req 17 / 7.
//      Kredensial WiFi RAHASIA: dari config.json/NVS, tidak di-hardcode.
//   3. Inisialisasi RTC DS3231 (rtc_time::begin) — Req 5.2.
//   4. Pasang hook ctx.hooks.{nowIso, ntpSync, enqueueLogLine}.
// Mengembalikan true bila LittleFS & RTC siap. Tetap memasang hook meski
// sebagian gagal (hook aman: timestamp fallback bila RTC absen).
// ---------------------------------------------------------------------------
bool setupStorageAndTime(AppContext& ctx);

// ---------------------------------------------------------------------------
// Hook implementations (tanda tangan sesuai app_config.h typedefs).
// Diekspos agar dapat diuji/dipasang eksplisit; biasanya dipasang oleh
// setupStorageAndTime().
// ---------------------------------------------------------------------------

// NowIsoFn: tulis timestamp ISO-8601 UTC dari RTC ke `out` (Req 5.2/5.4).
size_t hookNowIso(char* out, size_t cap);

// NtpSyncFn: sinkronkan RTC dari NTP saat online (Req 5.3).
bool hookNtpSync();

// EnqueueLogLineFn: parse baris JSONL lalu append ke offline_logs.jsonl
// (append-only, Req 5.1). Jika ts kosong & RTC tak andal, tandai
// ts_unverified=1 (Req 5.5) — lihat implementasi.
void hookEnqueueLogLine(const char* jsonlLine);

// ---------------------------------------------------------------------------
// Helper storage-backed untuk syncTask (Task 27.2). Tetap di sini agar panggilan
// LittleFS/lib portabel terkumpul di satu lapisan wiring.
// ---------------------------------------------------------------------------

// Baca seluruh antrean offline untuk diunggah (Req 6.2). Kembalikan false bila
// gagal baca FS.
bool drainOfflineLogsForUpload(std::vector<offline_log::LogEvent>& out);

// Setelah server ACK, hapus entri ber-ACK dari antrean (Req 6.3) via
// storage::pruneAckedAndPersist (lib portabel offline_log::pruneAcked).
bool confirmUploadedLogs(const std::vector<std::string>& ackedIds);

// Terapkan delta whitelist dari JSON respons server: parse → applyDeltaVerified
// (verifikasi db_hash, Req 4.3) → persist. `out` diisi snapshot hasil apply.
// Mengembalikan true iff db_hash cocok & tersimpan (pemanggil fallback full
// sync bila false).
bool applyWhitelistDeltaJson(const std::string& deltaJson,
                             whitelist::Snapshot& out);

// Baca db_version whitelist lokal saat ini dari LittleFS (Req 4.3). Dipakai
// syncTask (sync_client) sebagai `since_version` saat menarik delta. Mengembalikan
// 0 bila whitelist belum ada / gagal dibaca (→ setara full fetch).
int64_t currentWhitelistVersion();

}  // namespace app
}  // namespace smartdoor

#endif  // SMARTDOOR_APP_INTEGRATION_H
