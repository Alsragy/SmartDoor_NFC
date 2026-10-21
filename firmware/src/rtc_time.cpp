// ============================================================================
// rtc_time.cpp — Implementasi strategi waktu RTC DS3231 + NTP (Task 24).
//
// FIRMWARE-TARGET (ESP32/Arduino): bergantung pada RTClib (RTC_DS3231), Wire,
// dan SNTP/configTime ESP32. Blok hardware dijaga di balik guard
// SMARTDOOR_FIRMWARE_TARGET. Fungsi pembentukan ISO-8601 bersifat MURNI dan
// selalu dikompilasi (termasuk [env:native]) agar dapat di-unit-test di host.
//
// _Requirements: 5.2, 5.3, 5.4, 5.5, 18.1_
// ============================================================================
#include "rtc_time.h"

#if defined(ARDUINO) || defined(ESP32)
#define SMARTDOOR_FIRMWARE_TARGET 1
#endif

#include <cstdio>

#if defined(SMARTDOOR_FIRMWARE_TARGET)
#include <Arduino.h>
#include <RTClib.h>
#include <Wire.h>
#include <time.h>
#if defined(ESP32)
#include <WiFi.h>
#endif
#endif

namespace smartdoor {
namespace rtc_time {

// ---------------------------------------------------------------------------
// Fungsi MURNI — dikompilasi untuk semua environment (host & firmware).
// ---------------------------------------------------------------------------
std::string formatIso8601Utc(const DateTimeUtc& dt) {
  char buf[21];  // "YYYY-MM-DDTHH:MM:SSZ" + NUL = 21
  std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ", dt.year,
                dt.month, dt.day, dt.hour, dt.minute, dt.second);
  return std::string(buf);
}

std::string formatIso8601Utc(uint64_t epochSeconds) {
  // Konversi epoch UTC -> komponen kalender tanpa bergantung pada timezone host.
  // Algoritma civil-from-days (Howard Hinnant) untuk tanggal; sisanya jam/menit/detik.
  const uint64_t secsPerDay = 86400ULL;
  uint64_t days = epochSeconds / secsPerDay;
  uint64_t rem = epochSeconds % secsPerDay;

  DateTimeUtc dt;
  dt.hour = static_cast<int>(rem / 3600);
  rem %= 3600;
  dt.minute = static_cast<int>(rem / 60);
  dt.second = static_cast<int>(rem % 60);

  // days sejak 1970-01-01 → tanggal sipil.
  int64_t z = static_cast<int64_t>(days) + 719468;  // shift epoch ke 0000-03-01
  int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  uint64_t doe = static_cast<uint64_t>(z - era * 146097);           // [0, 146096]
  uint64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;  // [0, 399]
  int64_t y = static_cast<int64_t>(yoe) + era * 400;
  uint64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);            // [0, 365]
  uint64_t mp = (5 * doy + 2) / 153;                                // [0, 11]
  uint64_t d = doy - (153 * mp + 2) / 5 + 1;                        // [1, 31]
  uint64_t m = mp < 10 ? mp + 3 : mp - 9;                           // [1, 12]
  dt.year = static_cast<int>(y + (m <= 2 ? 1 : 0));
  dt.month = static_cast<int>(m);
  dt.day = static_cast<int>(d);
  return formatIso8601Utc(dt);
}

// ===========================================================================
// Di bawah: implementasi hardware (RTC DS3231 + NTP). Pada [env:native]
// disediakan stub agar modul dapat ditaut bila disertakan di build host; namun
// secara default modul ini hanya dibangun untuk esp32dev.
// ===========================================================================
#if !defined(SMARTDOOR_FIRMWARE_TARGET)

bool begin() { return false; }
bool isPresent() { return false; }
bool isTimeReliable() { return false; }
DateTimeUtc nowUtc() { return DateTimeUtc{}; }
std::string nowIso8601Utc() { return formatIso8601Utc(DateTimeUtc{}); }
uint64_t nowEpochSeconds() { return 0; }
bool syncRtcFromNtp(const NtpConfig&) { return false; }
bool setRtcFromEpoch(uint64_t) { return false; }

#else  // ===================== SMARTDOOR_FIRMWARE_TARGET ======================

namespace {
RTC_DS3231 g_rtc;
bool g_present = false;
// Reliabilitas jam (Req 5.5): mulai tak andal; menjadi andal setelah RTC valid
// (tidak lostPower) atau setelah sync NTP berhasil.
bool g_reliable = false;

// Konversi DateTime RTClib -> DateTimeUtc modul ini.
DateTimeUtc fromRtcLib(const DateTime& dtl) {
  DateTimeUtc dt;
  dt.year = dtl.year();
  dt.month = dtl.month();
  dt.day = dtl.day();
  dt.hour = dtl.hour();
  dt.minute = dtl.minute();
  dt.second = dtl.second();
  return dt;
}
}  // namespace

bool begin() {
  // DS3231 memakai I2C default (Wire). Inisialisasi bus lalu RTC.
  Wire.begin();
  g_present = g_rtc.begin();
  if (!g_present) {
    g_reliable = false;
    return false;
  }
  // lostPower() == true berarti baterai cadangan habis / waktu ter-reset
  // (Req 5.5). Jam belum dapat dipercaya sampai di-resync dari NTP.
  g_reliable = !g_rtc.lostPower();
  return true;
}

bool isPresent() { return g_present; }

bool isTimeReliable() {
  if (!g_present) {
    return false;  // tanpa RTC, timestamp tidak dapat dijamin akurat (Req 5.5)
  }
  // Selalu hormati laporan lostPower() terkini; sekali resync NTP, g_reliable
  // di-set true oleh markSyncedNow (setRtcFromEpoch).
  if (g_rtc.lostPower() && !g_reliable) {
    return false;
  }
  return g_reliable;
}

DateTimeUtc nowUtc() {
  if (!g_present) {
    return DateTimeUtc{};  // fallback epoch; pemanggil akan menandai tak andal
  }
  return fromRtcLib(g_rtc.now());
}

std::string nowIso8601Utc() {
  if (!g_present) {
    return formatIso8601Utc(DateTimeUtc{});
  }
  return formatIso8601Utc(nowUtc());
}

uint64_t nowEpochSeconds() {
  if (!g_present) {
    return 0;
  }
  return static_cast<uint64_t>(g_rtc.now().unixtime());
}

bool setRtcFromEpoch(uint64_t epochSeconds) {
  if (!g_present) {
    return false;
  }
  g_rtc.adjust(DateTime(static_cast<uint32_t>(epochSeconds)));
  // Jam kini berasal dari sumber tepercaya (NTP) → tandai andal (Req 5.5).
  g_reliable = true;
  return true;
}

bool syncRtcFromNtp(const NtpConfig& config) {
#if defined(ESP32)
  // Hanya bermakna saat WiFi terhubung (Req 5.3 — WHILE online).
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }
  // Konfigurasi SNTP ESP32 (UTC, tanpa DST). Non-blocking: configTime memulai
  // query SNTP di latar; kita polling bertimeout agar task tidak menggantung.
  configTime(config.gmtOffsetSec, config.daylightOffsetSec, config.server1,
             config.server2);

  const uint32_t start = millis();
  struct tm timeinfo;
  bool got = false;
  while (millis() - start < config.timeoutMs) {
    if (getLocalTime(&timeinfo, 100 /*ms per attempt*/)) {
      // getLocalTime sukses bila tahun > 1970-an (SNTP sudah mengisi waktu).
      if (timeinfo.tm_year + 1900 >= 2020) {
        got = true;
        break;
      }
    }
    // Yield singkat tanpa delay() panjang; timeTask memanggil wdt_reset sendiri.
    yield();
  }
  if (!got) {
    return false;
  }

  time_t now = time(nullptr);
  if (now <= 0) {
    return false;
  }
  // Set RTC DS3231 dari waktu NTP (UTC). Menandai jam andal (Req 5.3/5.5).
  return setRtcFromEpoch(static_cast<uint64_t>(now));
#else
  (void)config;
  return false;  // NTP via SNTP hanya tersedia di ESP32 di modul ini
#endif
}

#endif  // SMARTDOOR_FIRMWARE_TARGET

}  // namespace rtc_time
}  // namespace smartdoor
