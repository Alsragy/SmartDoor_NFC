// ============================================================================
// rtc_time.h — Strategi waktu RTC DS3231 + NTP untuk Smart Door KOS ESP32.
//
// Task 24 — Integrasi waktu. Modul FIRMWARE-TARGET (RTClib + WiFi/NTP ESP32):
// bergantung pada RTC_DS3231 & SNTP, sehingga TIDAK portabel ke host
// [env:native]. Fungsi pembentukan string ISO-8601 dari komponen waktu bersifat
// MURNI dan disediakan terpisah agar tetap dapat diuji di host.
//
// Strategi (design.md — "Strategi Waktu: RTC DS3231 + NTP", Req 5):
//   - RTC DS3231 = sumber waktu utama untuk timestamp log → akurat saat offline
//     dan setelah power loss selama baterai cadangan terjaga (Req 5.2, 5.4).
//   - timeTask menyinkronkan RTC dari NTP saat online (Req 5.3), lalu RTC
//     mempertahankan waktu dengan baterainya.
//   - Semua timestamp ditulis ISO-8601 UTC (mis. "2025-06-18T09:12:03Z").
//   - Deteksi kegagalan baterai / reset waktu RTC (RTClib lostPower()) →
//     ekspos flag agar log yang dibuat dengan jam tak andal ditandai
//     ts_unverified = 1 (Req 5.5; LogEvent.offline_log mendukung field ini).
//
// Semua panggilan hardware disembunyikan di balik fungsi yang jelas sehingga
// lapisan logika (nfcReadTask yang menyusun LogEvent) tetap dapat diuji.
//
// _Requirements: 5.2, 5.3, 5.4, 5.5_
// ============================================================================
#ifndef SMARTDOOR_RTC_TIME_H
#define SMARTDOOR_RTC_TIME_H

#include <cstdint>
#include <string>

namespace smartdoor {
namespace rtc_time {

// ---------------------------------------------------------------------------
// Komponen waktu kalender UTC — representasi netral-hardware agar fungsi
// pembentukan ISO-8601 dapat diuji di host tanpa RTClib.
// ---------------------------------------------------------------------------
struct DateTimeUtc {
  int year = 1970;
  int month = 1;   // 1..12
  int day = 1;     // 1..31
  int hour = 0;    // 0..23
  int minute = 0;  // 0..59
  int second = 0;  // 0..59
};

// ---------------------------------------------------------------------------
// formatIso8601Utc — MURNI: bentuk "YYYY-MM-DDTHH:MM:SSZ" dari komponen.
// Zero-padded; selalu UTC (suffix 'Z'). Deterministik & dapat di-unit-test.
// ---------------------------------------------------------------------------
std::string formatIso8601Utc(const DateTimeUtc& dt);

// Varian dari epoch detik (UTC) — MURNI. Berguna saat NTP mengembalikan epoch.
std::string formatIso8601Utc(uint64_t epochSeconds);

// ---------------------------------------------------------------------------
// Inisialisasi RTC DS3231
//   begin() : inisialisasi bus I2C + RTC. Mengembalikan true bila RTC terdeteksi.
//             Juga mengevaluasi lostPower() untuk menyetel flag reliabilitas awal.
// ---------------------------------------------------------------------------
bool begin();

// true bila RTC terdeteksi & diinisialisasi (begin() sukses).
bool isPresent();

// ---------------------------------------------------------------------------
// Reliabilitas jam (Req 5.5)
//   isTimeReliable() : false bila RTC melaporkan lostPower() (baterai cadangan
//                      habis / waktu ter-reset) dan belum di-resync dari NTP.
//                      Log yang dibuat saat ini HARUS ditandai ts_unverified=1.
//   markSyncedNow()  : dipanggil setelah sync NTP berhasil untuk menandai jam
//                      kembali andal (meng-clear kondisi lostPower logis).
// ---------------------------------------------------------------------------
bool isTimeReliable();

// ---------------------------------------------------------------------------
// Pembacaan waktu
//   nowUtc()        : komponen waktu UTC dari RTC (atau epoch fallback bila RTC
//                     tak ada, mis. millis-based — ditandai tak andal).
//   nowIso8601Utc() : timestamp ISO-8601 UTC dari RTC (Req 5.2/5.4). Dipakai
//                     nfcReadTask saat menyusun LogEvent.ts.
//   nowEpochSeconds(): epoch detik UTC dari RTC.
// ---------------------------------------------------------------------------
DateTimeUtc nowUtc();
std::string nowIso8601Utc();
uint64_t nowEpochSeconds();

// ---------------------------------------------------------------------------
// Sinkronisasi NTP (Req 5.3) — dipanggil timeTask saat online.
//   syncRtcFromNtp() : ambil waktu dari server NTP, set RTC DS3231, lalu tandai
//                      jam andal (markSyncedNow). Non-blocking-friendly: diberi
//                      timeout agar tidak menggantung task (lihat default).
//                      Mengembalikan true bila sync berhasil & RTC diperbarui.
//
// CATATAN non-blocking (Req 18.1): timeTask memanggil ini secara periodik (jam).
// Implementasi memakai configTime()/SNTP ESP32 dengan polling bertimeout, bukan
// delay() panjang. Pemanggil tetap memanggil esp_task_wdt_reset() di task.
// ---------------------------------------------------------------------------
struct NtpConfig {
  const char* server1 = "pool.ntp.org";
  const char* server2 = "time.nist.gov";
  long gmtOffsetSec = 0;       // UTC — timestamp selalu UTC (Req 5)
  int daylightOffsetSec = 0;   // tanpa DST (UTC)
  uint32_t timeoutMs = 5000;   // batas tunggu agar task tidak menggantung
};

bool syncRtcFromNtp(const NtpConfig& config = NtpConfig{});

// Set waktu RTC manual dari epoch UTC (dipakai internal syncRtcFromNtp &
// provisioning awal). Menandai jam andal. true bila RTC diperbarui.
bool setRtcFromEpoch(uint64_t epochSeconds);

}  // namespace rtc_time
}  // namespace smartdoor

#endif  // SMARTDOOR_RTC_TIME_H
