// ============================================================================
// tasks.cpp — Implementasi kerangka penjadwalan FreeRTOS non-blocking +
// watchdog (Task 23) — Smart Door KOS ESP32.
//
// Enam task (prioritas menurun): nfcReadTask > doorControlTask > wifiTask ==
// mqttTask > syncTask == timeTask. Tidak ada delay() di jalur kritis; tiap
// task memakai millis()-based timing dan vTaskDelay() sebagai YIELD. Tiap task
// memanggil esp_task_wdt_reset() setiap iterasi; TWDT dikonfigurasi me-restart
// controller bila ada task hang (Req 18.4/18.5).
//
// Catatan integrasi (SEAM): Task 23 TIDAK memuat driver hardware. Ia memanggil
// hook di AppContext::hooks (app_config.h). Hook kosong (nullptr) diperlakukan
// aman:
//   - nfcPoll == nullptr        -> tidak ada kartu (idle)
//   - doorIsOpen == nullptr     -> pintu dianggap tertutup
//   - relaySet/alarmSet null    -> no-op (hanya state logis diperbarui)
//   - nowIso == nullptr         -> timestamp fallback "" (Task 24 mengisinya)
//   - enqueueLogLine == nullptr -> log di-drop dengan aman (Task 24 mengisinya)
// Dengan begitu kerangka dapat berjalan & dijadwalkan sebelum Task 24/25/26.
//
// ArduinoJson (v7): alokasi JSON dibatasi memakai Allocator berkapasitas TETAP
// + buffer serialisasi berukuran tetap (Req 18.3). Pembangunan payload MQTT
// (heartbeat/log/event) beserta BoundedAllocator-nya kini berada di modul
// klien MQTT (mqtt_client.cpp, Task 27.1), bukan di tasks.cpp — adaptasi dari
// `StaticJsonDocument` (dihapus di v7). Tidak ada dokumen tak-berbatas yang
// dapat menghabiskan heap.
//
// _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5_
// ============================================================================

#include "tasks.h"

#include <WiFi.h>
#include <esp_task_wdt.h>

#include <cstring>

#include "access_decision.h"
#include "mqtt_client.h"  // Task 27.1: klien MQTT (connect/loop/publish*)
#include "offline_log.h"
#include "sync_client.h"  // Task 27.2: runSyncOnce (REST delta-sync & ingest)

namespace smartdoor {
namespace app {

// ===========================================================================
// Payload MQTT TERUKUR / BERBATAS (Req 18.3) — lihat mqtt_client.cpp
// ===========================================================================
//
// CATATAN VERSI: design.md & Task 23 menyebut `StaticJsonDocument<N>` sebagai
// cara membatasi alokasi. ArduinoJson v7 (di-pin ^7.1.0 di platformio.ini)
// MENGHAPUS `StaticJsonDocument`. Pembatasan alokasi (BoundedAllocator +
// buffer serialisasi berukuran tetap) kini berada di modul klien MQTT
// (mqtt_client.cpp, Task 27.1), yang membangun & menerbitkan SEMUA payload
// (heartbeat/log/event) secara terukur. tasks.cpp hanya memanggil publisher
// tersebut; tidak ada dokumen JSON tak-berbatas di jalur task.

// ===========================================================================
// Utilitas watchdog
// ===========================================================================

// Feed TWDT untuk task saat ini. Dipanggil tiap iterasi di SETIAP task.
static inline void feedWatchdog() { esp_task_wdt_reset(); }

void setupWatchdog() {
  // Konfigurasi TWDT: timeout + panic (reboot) saat ada task terdaftar yang
  // tidak di-reset dalam jendela (Req 18.4/18.5).
  //
  // FAIL-SAFE NOTE (Req 18.5): perlindungan "residen terkunci di luar"
  // bergantung SEMATA pada TWDT me-restart controller. Tidak ada jaminan
  // fail-safe-unlocked tambahan bila TWDT sendiri gagal (lihat app_config.h).
#if defined(ESP_TASK_WDT_INIT)  // IDF >= 5 API (esp_task_wdt_config_t)
  const esp_task_wdt_config_t wdtConfig = {
      .timeout_ms = watchdog::kTimeoutSeconds * 1000U,
      .idle_core_mask = 0,  // task kita didaftarkan manual, bukan idle task
      .trigger_panic = watchdog::kPanicRebootOnTimeout,
  };
  esp_task_wdt_init(&wdtConfig);
#else  // API lama (IDF 4.x / Arduino core lama): (timeout_s, panic)
  esp_task_wdt_init(watchdog::kTimeoutSeconds, watchdog::kPanicRebootOnTimeout);
#endif
}

// Daftarkan task yang sedang berjalan ke TWDT (dipanggil di awal tiap task).
static inline void watchdogSubscribe() { esp_task_wdt_add(nullptr); }

// ===========================================================================
// Task 1: nfcReadTask — PRIORITAS TERTINGGI (Req 3.3)
// ===========================================================================
//
// Poll reader NFC (hook Task 25), jalankan keputusan akses LOKAL murni
// (lib/decision — verifikasi kripto sudah dihitung Task 25 → cryptoValid),
// perbarui detektor brute-force (lib/security), set intent relay saat GRANT,
// dan enqueue log. TIDAK PERNAH menunggu jaringan — keputusan sepenuhnya dari
// whitelist lokal (Req 3.3/4.2).
void nfcReadTask(void* pv) {
  AppContext* ctx = static_cast<AppContext*>(pv);
  watchdogSubscribe();

  for (;;) {
    feedWatchdog();

    NfcTapResult tap;
    if (ctx->hooks.nfcPoll != nullptr) {
      tap = ctx->hooks.nfcPoll();  // NON-BLOCKING, <200 ms (Task 25)
    }

    if (tap.present) {
      // Keputusan akses offline-first (lib/decision/access_decision.h).
      // `nowMs` memakai millis() untuk evaluasi relatif; keputusan berbasis
      // expired_at absolut ditangani saat whitelist memuat epoch dari RTC
      // (Task 24). Di kerangka ini kita teruskan tap.card apa adanya.
      const int64_t nowMs = static_cast<int64_t>(millis());
      const decision::Outcome outcome =
          decision::decide(tap.cryptoValid, tap.card, nowMs);

      // Brute-force: tap DIKENAL (kartu ada di whitelist) mereset penghitung;
      // tap tak dikenal menaikkannya (lib/security). State disimpan di ctx
      // di bawah mutex singkat agar konsisten dengan pembaca lain.
      const bool isKnown = tap.card.valid;
      if (ctx->mutex != nullptr) {
        xSemaphoreTake(ctx->mutex, portMAX_DELAY);
      }
      const security::BruteForceResult bf =
          security::bruteForceOnTap(ctx->bruteForce, isKnown);
      ctx->bruteForce = bf.state;
      if (ctx->mutex != nullptr) {
        xSemaphoreGive(ctx->mutex);
      }

      if (outcome.granted()) {
        // Tandai intent; doorControlTask mengeksekusi relay + timer penutupan.
        ctx->relay.requestedAtMs = millis();
        ctx->relay.openRequested = true;
      }

      // Enqueue log akses (Req 5.1). Serialisasi via lib/offline_log (JSONL),
      // persistensi ke LittleFS lewat hook (Task 24). Timestamp dari RTC hook.
      {
        offline_log::LogEvent ev;
        ev.uid = tap.uid;
        ev.result = outcome.granted() ? "GRANT" : "DENY";
        ev.sync_type = "CACHED_OFFLINE";  // live-vs-offline ditandai syncTask/mqttTask
        char ts[32] = {0};
        if (ctx->hooks.nowIso != nullptr) {
          ctx->hooks.nowIso(ts, sizeof(ts));
          ev.ts = ts;
        }
        // id (idempotency key) diberikan Task 24 saat persist (counter
        // persisten). Di sini serialisasi dasar; hook melakukan append aman.
        std::string line = offline_log::serialize(ev);
        if (!line.empty() && ctx->hooks.enqueueLogLine != nullptr) {
          ctx->hooks.enqueueLogLine(line.c_str());
        }
      }

      // Tandai log akses LIVE (REALTIME) agar mqttTask mempublikasikannya saat
      // online (Req 14.1/15.2). Offline tetap tercatat via enqueueLogLine di
      // atas (CACHED_OFFLINE). Salin ke buffer tetap AppContext (tanpa heap).
      {
        if (ctx->mutex != nullptr) {
          xSemaphoreTake(ctx->mutex, portMAX_DELAY);
        }
        strncpy(const_cast<char*>(ctx->logUid), tap.uid, sizeof(ctx->logUid) - 1);
        const_cast<char*>(ctx->logUid)[sizeof(ctx->logUid) - 1] = '\0';
        const char* res = outcome.granted() ? "GRANT" : "DENY";
        strncpy(const_cast<char*>(ctx->logResult), res, sizeof(ctx->logResult) - 1);
        const_cast<char*>(ctx->logResult)[sizeof(ctx->logResult) - 1] = '\0';
        char ts2[32] = {0};
        if (ctx->hooks.nowIso != nullptr) {
          ctx->hooks.nowIso(ts2, sizeof(ts2));
        }
        strncpy(const_cast<char*>(ctx->logTs), ts2, sizeof(ctx->logTs) - 1);
        const_cast<char*>(ctx->logTs)[sizeof(ctx->logTs) - 1] = '\0';
        ctx->logPending = true;

        // Tandai event brute-force LIVE bila dipicu (Req 13.1). mqttTask
        // mempublikasikan { count, ts, api_key } ke event/bruteforce.
        if (bf.eventFired) {
          ctx->bruteforcePending = true;
          ctx->bruteforceCount = bf.count;
        }
        if (ctx->mutex != nullptr) {
          xSemaphoreGive(ctx->mutex);
        }
      }
    }

    // YIELD (bukan delay()). Polling 50 ms sesuai design.
    vTaskDelay(pdMS_TO_TICKS(period::kNfcPollMs));
  }
}

// ===========================================================================
// Task 2: doorControlTask — PRIORITAS TINGGI
// ===========================================================================
//
// Timer Lock_Open_Duration berbasis millis(), deteksi door-ajar (reed switch)
// + alarm, dan deteksi tamper (pintu terbuka tanpa relay). Mengikuti sketsa
// design.md "Model Penjadwalan Non-Blocking".
void doorControlTask(void* pv) {
  AppContext* ctx = static_cast<AppContext*>(pv);
  watchdogSubscribe();

  uint32_t doorOpenedAtMs = 0;  // millis() saat pintu mulai terbuka
  bool prevDoorOpen = false;

  for (;;) {
    feedWatchdog();
    const uint32_t now = millis();

    // --- Eksekusi intent relay (dari nfcReadTask / remote unlock) -----------
    if (ctx->relay.openRequested && !ctx->relayEngaged) {
      if (ctx->hooks.relaySet != nullptr) {
        ctx->hooks.relaySet(true);
      }
      ctx->relayEngaged = true;
      ctx->relayOpenedAtMs = now;
      ctx->relay.openRequested = false;  // intent dikonsumsi
    }

    // --- Timer penutupan: tutup setelah Lock_Open_Duration (Req 17.1) -------
    if (ctx->relayEngaged &&
        (now - ctx->relayOpenedAtMs) >= ctx->config.lockOpenDurationMs) {
      if (ctx->hooks.relaySet != nullptr) {
        ctx->hooks.relaySet(false);
      }
      ctx->relayEngaged = false;
    }

    // --- Baca status pintu (reed switch) ------------------------------------
    const bool doorOpen =
        (ctx->hooks.doorIsOpen != nullptr) ? ctx->hooks.doorIsOpen() : false;

    if (doorOpen && !prevDoorOpen) {
      doorOpenedAtMs = now;  // mulai menghitung durasi terbuka
    }

    // --- Alarm door-ajar: aktif iff durasi terbuka > Door_Ajar_Timeout ------
    // (lib/security/doorAjarIsAlarm, Req 17.4 — batas eksklusif).
    bool ajarAlarm = false;
    if (doorOpen) {
      const uint32_t openDuration = now - doorOpenedAtMs;
      ajarAlarm =
          security::doorAjarIsAlarm(openDuration, ctx->config.doorAjarTimeoutMs);
    }
    if (ctx->hooks.alarmSet != nullptr) {
      ctx->hooks.alarmSet(ajarAlarm);
    }

    // --- Deteksi tamper: transisi tertutup->terbuka TANPA relay aktif -------
    // (lib/security/tamperOnDoorTransition, Req 13.2 forced open).
    if (ctx->mutex != nullptr) {
      xSemaphoreTake(ctx->mutex, portMAX_DELAY);
    }
    const security::TamperResult tr = security::tamperOnDoorTransition(
        ctx->tamper, doorOpen, ctx->relayEngaged);
    ctx->tamper = tr.state;
    if (ctx->mutex != nullptr) {
      xSemaphoreGive(ctx->mutex);
    }
    if (tr.eventFired) {
      // Tandai event tamper LIVE agar mqttTask mempublikasikannya saat online
      // (Req 13.2). Flag volatile; aman di-set di luar mutex (single writer).
      ctx->tamperPending = true;
      // Enqueue event tamper agar tidak hilang saat offline (design Req 13);
      // mqttTask mempublikasikannya saat online. Di kerangka: catat via log.
      if (ctx->hooks.enqueueLogLine != nullptr) {
        offline_log::LogEvent ev;
        ev.result = "DENY";
        ev.sync_type = "CACHED_OFFLINE";
        char ts[32] = {0};
        if (ctx->hooks.nowIso != nullptr) {
          ctx->hooks.nowIso(ts, sizeof(ts));
          ev.ts = ts;
        }
        std::string line = offline_log::serialize(ev);
        if (!line.empty()) {
          ctx->hooks.enqueueLogLine(line.c_str());
        }
      }
    }

    prevDoorOpen = doorOpen;

    // YIELD 20 ms (sketsa design) — bukan delay().
    vTaskDelay(pdMS_TO_TICKS(period::kDoorControlMs));
  }
}

// ===========================================================================
// Task 3: wifiTask — state machine rekoneksi NON-BLOCKING + backoff (Req 18.2)
// ===========================================================================
//
// DISCONNECTED -> CONNECTING -> CONNECTED. Kegagalan WiFi TIDAK memblok
// nfcReadTask/doorControlTask (keduanya tidak menyentuh WiFi). Memakai
// exponential backoff antar percobaan.
void wifiTask(void* pv) {
  AppContext* ctx = static_cast<AppContext*>(pv);
  watchdogSubscribe();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);  // kita kelola rekoneksi sendiri (non-blocking)

  ctx->wifi.state = WifiState::DISCONNECTED;
  ctx->wifi.currentDelayMs = ctx->wifi.baseDelayMs;
  ctx->wifi.lastTransitionMs = millis();

  for (;;) {
    feedWatchdog();
    const uint32_t now = millis();
    const bool linkUp = (WiFi.status() == WL_CONNECTED);

    switch (ctx->wifi.state) {
      case WifiState::DISCONNECTED: {
        ctx->wifiConnected = false;
        // Tunggu jeda backoff lalu mulai satu percobaan koneksi.
        if ((now - ctx->wifi.lastTransitionMs) >= ctx->wifi.currentDelayMs) {
          WiFi.begin(ctx->config.wifi.ssid, ctx->config.wifi.password);
          ctx->wifi.state = WifiState::CONNECTING;
          ctx->wifi.attemptStartedMs = now;
          ctx->wifi.lastTransitionMs = now;
        }
        break;
      }

      case WifiState::CONNECTING: {
        ctx->wifiConnected = false;
        if (linkUp) {
          // Sukses: reset backoff, tandai perlu sync (pemulihan WiFi, Req 6.1).
          ctx->wifi.state = WifiState::CONNECTED;
          ctx->wifi.currentDelayMs = ctx->wifi.baseDelayMs;
          ctx->wifi.lastTransitionMs = now;
          ctx->wifiConnected = true;
          ctx->syncRequested = true;
        } else if ((now - ctx->wifi.attemptStartedMs) >=
                   ctx->wifi.connectTimeoutMs) {
          // Gagal dalam batas waktu: naikkan backoff, kembali DISCONNECTED.
          WiFi.disconnect(/*wifioff=*/false);
          ctx->wifi.currentDelayMs = ctx->wifi.nextDelay(ctx->wifi.currentDelayMs);
          ctx->wifi.state = WifiState::DISCONNECTED;
          ctx->wifi.lastTransitionMs = now;
        }
        break;
      }

      case WifiState::CONNECTED: {
        if (!linkUp) {
          // Link putus: kembali ke DISCONNECTED dengan backoff dasar.
          ctx->wifiConnected = false;
          ctx->wifi.state = WifiState::DISCONNECTED;
          ctx->wifi.currentDelayMs = ctx->wifi.baseDelayMs;
          ctx->wifi.lastTransitionMs = now;
        } else {
          ctx->wifiConnected = true;
        }
        break;
      }
    }

    // YIELD — evaluasi state machine periodik, tidak memblok.
    vTaskDelay(pdMS_TO_TICKS(period::kWifiTickMs));
  }
}

// ===========================================================================
// Task 4: mqttTask — heartbeat, live log/event, subscribe perintah
// ===========================================================================
//
// Kerangka: hanya saat WiFi tersambung. Publikasi heartbeat berkala
// (millis-based). Koneksi broker + topik + validasi api_key payload
// diimplementasikan Task 27.1; di sini disediakan loop non-blocking + titik
// publish heartbeat terukur (Req 18.3) sebagai SEAM.
void mqttTask(void* pv) {
  AppContext* ctx = static_cast<AppContext*>(pv);
  watchdogSubscribe();

  // Klien MQTT statik (satu per perangkat). Dibuat sekali; memegang ctx untuk
  // dispatch perintah ke SEAM relay/whitelist. begin() menyetel server broker
  // dari ctx->config.mqtt + callback perintah (Task 27.1).
  static MqttClient client;
  client.begin(ctx);

  uint32_t lastHeartbeatMs = 0;

  for (;;) {
    feedWatchdog();
    const uint32_t now = millis();

    if (ctx->wifiConnected) {
      // Keep-alive broker + proses pesan masuk (subscribe cmd/* + validasi
      // api_key di dalam loop/handler). connect() otomatis dengan backoff.
      const bool up = client.loop();
      ctx->mqttConnected = up;

      if (up) {
        // Heartbeat berkala (Req 11.1): rssi/fs_free/db_version/ts/api_key.
        if ((now - lastHeartbeatMs) >= period::kHeartbeatMs) {
          lastHeartbeatMs = now;
          client.publishHeartbeat();
        }

        // Log akses LIVE (REALTIME, Req 14.1/15.2) — snapshot di bawah mutex.
        bool haveLog = false;
        char uid[24] = {0};
        char result[16] = {0};
        char ts[32] = {0};
        if (ctx->mutex != nullptr) {
          xSemaphoreTake(ctx->mutex, portMAX_DELAY);
        }
        if (ctx->logPending) {
          strncpy(uid, const_cast<const char*>(ctx->logUid), sizeof(uid) - 1);
          strncpy(result, const_cast<const char*>(ctx->logResult),
                  sizeof(result) - 1);
          strncpy(ts, const_cast<const char*>(ctx->logTs), sizeof(ts) - 1);
          ctx->logPending = false;
          haveLog = true;
        }
        // Event brute-force LIVE (Req 13.1).
        bool haveBrute = false;
        uint32_t bruteCount = 0;
        if (ctx->bruteforcePending) {
          bruteCount = ctx->bruteforceCount;
          ctx->bruteforcePending = false;
          haveBrute = true;
        }
        if (ctx->mutex != nullptr) {
          xSemaphoreGive(ctx->mutex);
        }

        if (haveLog) {
          client.publishLog(uid, result, ts);
        }
        if (haveBrute) {
          char ets[32] = {0};
          if (ctx->hooks.nowIso != nullptr) {
            ctx->hooks.nowIso(ets, sizeof(ets));
          }
          client.publishBruteforce(bruteCount, ets);
        }

        // Event tamper LIVE (Req 13.2) — flag single-writer (doorControlTask).
        if (ctx->tamperPending) {
          ctx->tamperPending = false;
          char ets[32] = {0};
          if (ctx->hooks.nowIso != nullptr) {
            ctx->hooks.nowIso(ets, sizeof(ets));
          }
          client.publishTamper(ets);
        }
      }
    } else {
      ctx->mqttConnected = false;  // tak ada link -> tak ada MQTT
    }

    vTaskDelay(pdMS_TO_TICKS(period::kMqttTickMs));
  }
}

// ===========================================================================
// Task 5: syncTask — PRIORITAS RENDAH; dipicu saat WiFi pulih (Req 6.1)
// ===========================================================================
//
// Saat `syncRequested` (transisi DISCONNECTED->CONNECTED), lakukan: push
// offline logs lalu pull whitelist delta. Implementasi REST + idempotency ids
// + verifikasi db_hash ada di Task 27.2; di sini kerangka non-blocking + SEAM.
void syncTask(void* pv) {
  AppContext* ctx = static_cast<AppContext*>(pv);
  watchdogSubscribe();

  for (;;) {
    feedWatchdog();

    if (ctx->wifiConnected && ctx->syncRequested) {
      ctx->syncRequested = false;  // konsumsi trigger (sekali per pemulihan)

      // Task 27.2 — jalankan satu siklus delta-sync REST (sync_client):
      //   1) POST /api/devices/:dev/offline-logs (batch + idempotency ids)
      //      -> hapus entri ber-ACK (confirmUploadedLogs → offline_log::pruneAcked).
      //   2) GET  /api/devices/:dev/whitelist?since_version=N
      //      -> applyWhitelistDeltaJson (applyDeltaVerified + verifikasi db_hash,
      //         Req 4.3); fallback full fetch bila db_hash gagal.
      // Setiap request menyertakan X-API-Key (Req 7.3). Dijalankan di task
      // prioritas RENDAH + transport timeout-bounded (sync_limits::kHttpTimeoutMs)
      // sehingga TIDAK memblok nfcReadTask/doorControlTask. Transport default
      // (ESP32 HTTPClient) dipakai bila argumen nullptr.
      (void)runSyncOnce(*ctx, /*transport=*/nullptr);

      // feed watchdog segera setelah siklus sync (bisa makan waktu beberapa
      // request) agar jendela TWDT tidak terlampaui sebelum yield.
      feedWatchdog();
    }

    vTaskDelay(pdMS_TO_TICKS(period::kSyncTickMs));
  }
}

// ===========================================================================
// Task 6: timeTask — sinkron RTC<->NTP saat online (Req 5.3)
// ===========================================================================
//
// Periodik (tiap jam) + sekali saat WiFi pulih. RTC DS3231 tetap sumber waktu
// utama offline (Task 24); timeTask hanya mengoreksinya dari NTP saat online.
void timeTask(void* pv) {
  AppContext* ctx = static_cast<AppContext*>(pv);
  watchdogSubscribe();

  uint32_t lastNtpSyncMs = 0;
  bool everSynced = false;

  for (;;) {
    feedWatchdog();
    const uint32_t now = millis();

    if (ctx->wifiConnected) {
      const bool due = !everSynced || (now - lastNtpSyncMs) >= period::kNtpSyncMs;
      if (due && ctx->hooks.ntpSync != nullptr) {
        if (ctx->hooks.ntpSync()) {  // SEAM Task 24: tulis hasil NTP ke RTC
          lastNtpSyncMs = now;
          everSynced = true;
        }
      }
    }

    vTaskDelay(pdMS_TO_TICKS(period::kTimeTickMs));
  }
}

// ===========================================================================
// startTasks — buat keenam task, mutex, dan daftarkan ke TWDT
// ===========================================================================

bool startTasks(AppContext* ctx) {
  if (ctx == nullptr) {
    return false;
  }

  // Mutex untuk field gabungan (snapshot keamanan) lintas-task.
  if (ctx->mutex == nullptr) {
    ctx->mutex = xSemaphoreCreateMutex();
    if (ctx->mutex == nullptr) {
      return false;
    }
  }

  // Buat task. Prioritas tertinggi (nfcReadTask) dibuat agar verifikasi lokal
  // tidak kelaparan CPU meski task jaringan sibuk (design.md).
  BaseType_t ok = pdPASS;

  ok &= xTaskCreate(nfcReadTask, "nfcRead", stack::kNfcRead, ctx,
                    prio::kNfcRead, nullptr);
  ok &= xTaskCreate(doorControlTask, "doorCtl", stack::kDoorControl, ctx,
                    prio::kDoorControl, nullptr);
  ok &= xTaskCreate(wifiTask, "wifi", stack::kWifi, ctx, prio::kWifi, nullptr);
  ok &= xTaskCreate(mqttTask, "mqtt", stack::kMqtt, ctx, prio::kMqtt, nullptr);
  ok &= xTaskCreate(syncTask, "sync", stack::kSync, ctx, prio::kSync, nullptr);
  ok &= xTaskCreate(timeTask, "time", stack::kTime, ctx, prio::kTime, nullptr);

  return ok == pdPASS;
}

}  // namespace app
}  // namespace smartdoor
