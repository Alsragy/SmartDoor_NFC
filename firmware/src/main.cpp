// ============================================================================
// Smart Door KOS — Firmware ESP32 entry point (WIRING PENUH — Task 29)
//
// Entry point ini MERAKIT seluruh firmware menjadi satu kesatuan koheren:
// memuat config.json, memasang hook LittleFS/RTC, mengonfigurasi watchdog, dan
// menjalankan keenam FreeRTOS task yang saling bekerja sama secara non-blocking.
//
// URUTAN setup() (Task 29):
//   1. Serial.begin — diagnostik boot.
//   2. setupStorageAndTime(g_ctx)  [Task 24 + 29]:
//        - mount LittleFS;
//        - muat config.json → g_ctx.config (device_id, api_key, timer
//          lock/door, mqtt host/port/base_topic, whitelist_url, DAN kredensial
//          wifi ssid/password) — RAHASIA bersumber dari config.json/NVS, bukan
//          hardcode (Req 3.1/4.2/5.2/7.1/17);
//        - inisialisasi RTC DS3231 (Req 5.2);
//        - pasang hook waktu/log: nowIso, ntpSync, enqueueLogLine.
//   3. setupWatchdog()  [Task 23]: TWDT + panic-reboot (Req 18.4/18.5).
//   4. startTasks(&g_ctx)  [Task 23]: buat 6 task + mutex + daftar ke TWDT.
//
// MODUL YANG DIRAKIT (semua sudah ada; main.cpp menyatukannya):
//   - Logika portabel lib/ (decision/security/whitelist/offline_log) dipakai
//     task via hook & storage, memberi keputusan LOKAL murni (Req 3.1/3.3).
//   - storage.* (LittleFS) sumber whitelist/log/config (Req 4.2/5.1).
//   - rtc_time.* (DS3231 + NTP) sumber timestamp (Req 5.2).
//   - mqtt_client.* diinstansiasi di dalam mqttTask (Req 7.1).
//   - sync_client.* (runSyncOnce) dipanggil syncTask saat WiFi pulih (Req 6).
//   - app_integration.* memasang hook waktu/log ke seam.
//
// HOOK PERANGKAT KERAS yang SENGAJA dibiarkan nullptr di sini:
//   - ctx.hooks.nfcPoll        → DIPASANG Task 25 (driver NFC + verifikasi
//                                 kripto AES challenge-response).
//   - ctx.hooks.relaySet       → DIPASANG Task 26 (driver relay kunci).
//   - ctx.hooks.doorIsOpen     → DIPASANG Task 26 (reed switch).
//   - ctx.hooks.alarmSet       → DIPASANG Task 26 (alarm door-ajar).
// Hook ini adalah DRIVER PERANGKAT KERAS yang tidak tersedia di lingkungan ini;
// kerangka task memperlakukan hook null SECARA AMAN (nfcPoll null → idle, door
// null → tertutup, relay/alarm null → no-op). JANGAN memalsukan driver di sini.
//
// STANDAR NON-BLOCKING (Req 18.1): tanpa delay() di jalur kritis; verifikasi
// kartu lokal tidak menunggu jaringan (Req 3.3); rekoneksi WiFi non-blocking
// (Req 18.2); alokasi ArduinoJson terukur (Req 18.3); TWDT aktif (Req 18.4);
// hang memicu restart controller (Req 18.5, fail-safe note di app_config.h).
// ============================================================================

#include <Arduino.h>

#include "app_integration.h"  // Task 24: wiring LittleFS + RTC ke hooks
#include "tasks.h"

// Konteks aplikasi bersama (dibuat sekali, hidup selama firmware berjalan).
// Dialokasikan statis (bukan heap) agar deterministik dan tidak fragmentasi.
static smartdoor::app::AppContext g_ctx;

void setup() {
  Serial.begin(115200);
  Serial.println(F("[boot] Smart Door KOS firmware — wiring penuh (Task 29)"));

  // mount LittleFS, muat config.json ke g_ctx.config (termasuk kredensial WiFi
  // ssid/password → g_ctx.config.wifi, dipakai wifiTask), inisialisasi RTC
  // DS3231, dan pasang hook waktu/log (nowIso, ntpSync, enqueueLogLine).
  //
  // CATATAN WIRING (Task 29): hook NFC (ctx.hooks.nfcPoll, Task 25) dan
  // relay/reed/alarm (ctx.hooks.relaySet/doorIsOpen/alarmSet, Task 26) adalah
  // DRIVER PERANGKAT KERAS — sengaja TIDAK dipasang di sini dan dibiarkan
  // nullptr. Task 25/26 yang memasangnya pada perangkat nyata; kerangka task
  // memperlakukan hook null secara aman sehingga firmware tetap berjalan.
  if (!smartdoor::app::setupStorageAndTime(g_ctx)) {
    // Non-fatal: default aman + fallback timestamp dipakai bila FS/RTC belum
    // siap. Verifikasi kartu lokal tetap berjalan (Req 3.3/18.2).
    Serial.println(F("[boot] WARN: LittleFS/config/RTC belum lengkap — default aman"));
  } else {
    Serial.println(F("[boot] Task 24: LittleFS + RTC siap; hook waktu/log terpasang"));
  }

  // Konfigurasi Task Watchdog Timer sebelum membuat task (Req 18.4/18.5).
  smartdoor::app::setupWatchdog();

  // Buat keenam task FreeRTOS + daftarkan tiap task ke TWDT.
  if (!smartdoor::app::startTasks(&g_ctx)) {
    Serial.println(F("[boot] FATAL: gagal membuat task FreeRTOS"));
    // Tanpa task, TWDT tidak ter-feed → controller akan di-restart (Req 18.5).
  } else {
    Serial.println(F("[boot] 6 task dijadwalkan (nfc/door/wifi/mqtt/sync/time)"));
  }
}

void loop() {
  // Seluruh kerja berjalan di FreeRTOS task. Loop idle non-blocking: tidak ada
  // delay() (Req 18.1). Yield agar task Arduino-loop (prioritas terendah) tidak
  // memonopoli CPU; TWDT untuk task ini tidak didaftarkan (loop tidak kritis).
  vTaskDelay(pdMS_TO_TICKS(1000));
}
