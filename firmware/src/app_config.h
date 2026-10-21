// ============================================================================
// app_config.h — Konfigurasi runtime bersama & SEAM integrasi perangkat keras
// untuk kerangka penjadwalan FreeRTOS (Task 23) — Smart Door KOS ESP32.
//
// Berkas ini mendefinisikan:
//   1. Struct konfigurasi runtime (`AppConfig`) — nilai dari config.json
//      (Lock_Open_Duration, Door_Ajar_Timeout, kredensial MQTT/WiFi, dsb.).
//      Nilai konkret dimuat oleh Task 24 (LittleFS). Di sini hanya SHAPE +
//      default aman agar task dapat dikompilasi & dijadwalkan.
//   2. Konstanta penjadwalan (periode, prioritas, stack, timeout watchdog).
//   3. SEAM integrasi perangkat keras: tipe fungsi (hooks) yang DIISI oleh
//      Task 24 (LittleFS/RTC), Task 25 (NFC/kripto) dan Task 26 (relay/reed).
//      Kerangka task hanya MEMANGGIL hook ini; tidak ada driver hardware di
//      Task 23. Hook yang belum terpasang (nullptr) diperlakukan aman
//      (mis. doorIsOpen() default tertutup, verifikasi default DENY).
//
// TIDAK ADA logika keputusan di sini — itu tetap di lib/ portabel
// (decision/, security/, whitelist/, offline_log/). Berkas ini adalah lem
// firmware (Arduino-target), bukan modul portabel host.
//
// _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5_
// ============================================================================
#ifndef SMARTDOOR_APP_CONFIG_H
#define SMARTDOOR_APP_CONFIG_H

#include <Arduino.h>

#include <cstdint>

#include "access_decision.h"  // smartdoor::decision::Card / Outcome (lib/decision)

namespace smartdoor {
namespace app {

// ===========================================================================
// 1) Konfigurasi runtime (shape config.json — lihat data/config.json)
// ===========================================================================

// Parameter MQTT (Req 7.1). Dimuat dari config.json oleh Task 24.
struct MqttConfig {
  char host[64] = {0};
  uint16_t port = 1883;
  char baseTopic[32] = "smartdoor";
};

// Parameter WiFi. Kredensial dimuat dari config.json / NVS oleh Task 24.
struct WifiConfig {
  char ssid[33] = {0};
  char password[64] = {0};
};

// Konfigurasi aplikasi gabungan. Nilai default bersifat AMAN untuk startup
// sebelum config.json termuat (Task 24 menimpanya).
struct AppConfig {
  // Identitas perangkat — dipakai sebagai prefiks idempotency key offline-log
  // (lihat offline_log::IdempotencyCounter).
  char deviceId[32] = "dev01";

  // API_Key disertakan di tiap payload MQTT & request REST (Req 7.3/7.4).
  char apiKey[64] = {0};

  // Timer kontrol pintu (Req 17.1/17.2). Disimpan dalam MILIDETIK agar langsung
  // dibandingkan dengan millis() di doorControlTask tanpa konversi berulang.
  uint32_t lockOpenDurationMs = 5000;   // Lock_Open_Duration (default 5 s)
  uint32_t doorAjarTimeoutMs = 30000;   // Door_Ajar_Timeout (default 30 s)

  WifiConfig wifi;
  MqttConfig mqtt;

  // URL whitelist penuh/delta untuk syncTask (Req 4.1/4.3).
  char whitelistUrl[160] = {0};

  // Helper: isi durasi dari nilai detik config.json.
  void setLockOpenSeconds(uint32_t seconds) { lockOpenDurationMs = seconds * 1000UL; }
  void setDoorAjarSeconds(uint32_t seconds) { doorAjarTimeoutMs = seconds * 1000UL; }
};

// ===========================================================================
// 2) Konstanta penjadwalan FreeRTOS (Req 18.1)
// ===========================================================================
//
// Prioritas: angka lebih besar = prioritas lebih tinggi (konvensi FreeRTOS).
// nfcReadTask tertinggi agar verifikasi lokal <200 ms tidak terganggu
// networking (design.md "Model Penjadwalan Non-Blocking").
namespace prio {
inline constexpr UBaseType_t kNfcRead = 5;      // Tertinggi
inline constexpr UBaseType_t kDoorControl = 4;  // Tinggi
inline constexpr UBaseType_t kWifi = 3;         // Sedang
inline constexpr UBaseType_t kMqtt = 3;         // Sedang
inline constexpr UBaseType_t kSync = 2;         // Rendah
inline constexpr UBaseType_t kTime = 1;         // Rendah
}  // namespace prio

// Ukuran stack per task (word/byte sesuai port; ESP32 memakai byte).
// Dibuat konservatif; task jaringan lebih besar karena TLS/REST buffer.
namespace stack {
inline constexpr uint32_t kNfcRead = 4096;
inline constexpr uint32_t kDoorControl = 3072;
inline constexpr uint32_t kWifi = 4096;
inline constexpr uint32_t kMqtt = 6144;
inline constexpr uint32_t kSync = 8192;
inline constexpr uint32_t kTime = 4096;
}  // namespace stack

// Periode polling/yield tiap task (ms). Dipakai sebagai argumen vTaskDelay()
// (YIELD, bukan blocking delay()). Nilai dipilih agar nfcReadTask merespons
// cepat sementara task latar tidak membebani CPU.
namespace period {
inline constexpr uint32_t kNfcPollMs = 50;        // design: polling 50 ms
inline constexpr uint32_t kDoorControlMs = 20;    // design: yield 20 ms
inline constexpr uint32_t kWifiTickMs = 250;      // evaluasi state machine WiFi
inline constexpr uint32_t kMqttTickMs = 100;      // mqtt loop + keep-alive
inline constexpr uint32_t kSyncTickMs = 500;      // cek kebutuhan sync
inline constexpr uint32_t kTimeTickMs = 1000;     // cek jadwal NTP
inline constexpr uint32_t kHeartbeatMs = 15000;   // heartbeat MQTT (Req 11.1)
inline constexpr uint32_t kNtpSyncMs = 3600000;   // sinkron NTP tiap jam (Req 5.3)
}  // namespace period

// ===========================================================================
// 3) Konfigurasi Task Watchdog Timer (TWDT) — Req 18.4 / 18.5
// ===========================================================================
//
// Timeout harus LEBIH BESAR dari periode terlama + margin kerja wajar tiap
// task agar tidak false-trigger, namun cukup kecil agar hang nyata memicu
// restart tepat waktu. Tiap task yang didaftarkan WAJIB memanggil
// esp_task_wdt_reset() dalam jendela ini (lihat tasks.cpp).
namespace watchdog {
inline constexpr uint32_t kTimeoutSeconds = 10;

// FAIL-SAFE NOTE (Req 18.5, versi yang telah diperhalus):
// Perlindungan terhadap kondisi "residen terkunci di luar" bergantung SEMATA
// pada keberhasilan TWDT me-restart controller saat firmware hang. TIDAK ADA
// jaminan fail-safe-unlocked tambahan: bila TWDT sendiri gagal me-restart
// (mis. kegagalan perangkat keras timer), sistem tidak menyediakan mekanisme
// pembukaan cadangan. Panic handler dikonfigurasi untuk me-reboot (bukan
// sekadar halt) agar jalur restart sepenuhnya otomatis.
inline constexpr bool kPanicRebootOnTimeout = true;
}  // namespace watchdog

// ===========================================================================
// 4) SEAM integrasi perangkat keras (hooks) — diisi Task 24/25/26
// ===========================================================================
//
// Kerangka task (Task 23) BEBAS hardware: ia memanggil hook di bawah ini.
// Task integrasi mengisinya dengan driver nyata. Semua hook harus NON-BLOCKING
// bila dipanggil dari jalur kritis (nfcReadTask/doorControlTask).

// --- NFC / kripto (Task 25) -----------------------------------------------

// Hasil pembacaan satu kartu oleh reader NFC. `present == false` berarti tidak
// ada kartu di medan (polling idle). `cryptoValid` adalah hasil verifikasi
// challenge-response AES-128 (lib/decision/crypto_verify.h) yang dijalankan
// Task 25 — Task 23 TIDAK melakukan kripto sendiri, hanya menerima hasilnya.
struct NfcTapResult {
  bool present = false;        // true bila ada kartu terbaca siklus ini
  bool cryptoValid = false;    // hasil verifikasi kripto (Req 1.1/1.5)
  char uid[24] = {0};          // UID hex (untuk log / lookup whitelist)
  decision::Card card;         // entri whitelist tercocok (card.valid=false bila UID tak dikenal)
};

// Poll reader NFC sekali (NON-BLOCKING, <200 ms, tidak menunggu jaringan).
// Diisi Task 25. Mengembalikan NfcTapResult.present=false bila tak ada kartu.
using NfcPollFn = NfcTapResult (*)();

// --- Relay (Task 26) -------------------------------------------------------

// Aktifkan (buka kunci) / nonaktifkan relay. Diisi Task 26.
using RelaySetFn = void (*)(bool engaged);

// --- Reed switch / pintu (Task 26) ----------------------------------------

// Baca status pintu dari reed switch. true = terbuka. Diisi Task 26.
// Default aman (bila nullptr): dianggap tertutup.
using DoorIsOpenFn = bool (*)();

// --- Alarm (Task 26) -------------------------------------------------------

// Aktif/nonaktifkan alarm door-ajar. Diisi Task 26.
using AlarmSetFn = void (*)(bool on);

// --- Waktu / RTC (Task 24) -------------------------------------------------

// Timestamp ISO-8601 UTC saat ini dari RTC DS3231 (Req 5). Diisi Task 24.
// Menulis ke buffer `out` (kapasitas `cap`). Mengembalikan panjang tertulis.
using NowIsoFn = size_t (*)(char* out, size_t cap);

// Sinkronkan RTC dari NTP (dipanggil timeTask saat online, Req 5.3). Diisi
// Task 24. Mengembalikan true bila sinkron sukses.
using NtpSyncFn = bool (*)();

// --- Persistensi offline-log & whitelist (Task 24) ------------------------

// Enqueue satu baris log JSONL ke offline_logs.jsonl (append-only, Req 5.1).
// Diisi Task 24. Baris sudah diserialisasi oleh pemanggil (offline_log::serialize).
using EnqueueLogLineFn = void (*)(const char* jsonlLine);

// Kumpulan hook perangkat keras / platform. Pointer null = belum terpasang;
// kerangka memperlakukan hook null secara aman (lihat tasks.cpp).
struct HardwareHooks {
  NfcPollFn nfcPoll = nullptr;
  RelaySetFn relaySet = nullptr;
  DoorIsOpenFn doorIsOpen = nullptr;
  AlarmSetFn alarmSet = nullptr;
  NowIsoFn nowIso = nullptr;
  NtpSyncFn ntpSync = nullptr;
  EnqueueLogLineFn enqueueLogLine = nullptr;
};

}  // namespace app
}  // namespace smartdoor

#endif  // SMARTDOOR_APP_CONFIG_H
