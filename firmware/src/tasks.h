// ============================================================================
// tasks.h — Kerangka penjadwalan FreeRTOS non-blocking + watchdog (Task 23).
// Smart Door KOS ESP32.
//
// Mendeklarasikan:
//   - AppContext: state bersama antar-task (config, hooks, state machine WiFi,
//      snapshot keamanan, intent relay) dengan sinkronisasi seperlunya.
//   - WifiState: state machine rekoneksi WiFi non-blocking + backoff (Req 18.2).
//   - Entry point tiap task FreeRTOS:
//       nfcReadTask, doorControlTask, wifiTask, mqttTask, syncTask, timeTask.
//   - setupWatchdog(): konfigurasi TWDT (Req 18.4/18.5).
//   - startTasks(): buat keenam task dengan prioritas/stack dari app_config.h,
//      daftarkan tiap task ke TWDT.
//
// ArduinoJson: SEMUA parse/serialize di jalur firmware WAJIB memakai dokumen
// TERUKUR / StaticJsonDocument berbatas (Req 18.3) — lihat makConfig & helper
// di tasks.cpp. Tidak ada DynamicJsonDocument tak-berbatas.
//
// _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5_
// ============================================================================
#ifndef SMARTDOOR_TASKS_H
#define SMARTDOOR_TASKS_H

#include <Arduino.h>

#include "app_config.h"
#include "security_state.h"  // lib/security — brute-force / tamper / door-ajar

namespace smartdoor {
namespace app {

// ---------------------------------------------------------------------------
// State machine rekoneksi WiFi (Req 18.2): DISCONNECTED -> CONNECTING ->
// CONNECTED, dengan exponential backoff saat gagal. Dijalankan oleh wifiTask;
// KEGAGALAN WIFI TIDAK PERNAH memblok nfcReadTask/doorControlTask.
// ---------------------------------------------------------------------------
enum class WifiState : uint8_t {
  DISCONNECTED = 0,  // idle; menunggu jadwal percobaan berikut (backoff)
  CONNECTING = 1,    // WiFi.begin() dipanggil; menunggu asosiasi non-blocking
  CONNECTED = 2,     // terasosiasi + punya IP
};

// Parameter exponential backoff rekoneksi WiFi.
struct WifiBackoff {
  uint32_t baseDelayMs = 1000;    // jeda awal antar percobaan
  uint32_t maxDelayMs = 60000;    // batas atas jeda (1 menit)
  uint32_t connectTimeoutMs = 15000;  // batas satu percobaan CONNECTING

  // State backoff berjalan.
  WifiState state = WifiState::DISCONNECTED;
  uint32_t currentDelayMs = 1000;    // jeda saat ini (naik x2 tiap gagal)
  uint32_t lastTransitionMs = 0;     // millis() transisi terakhir
  uint32_t attemptStartedMs = 0;     // millis() mulai percobaan CONNECTING

  // Hitung jeda backoff berikutnya (x2, di-clamp ke maxDelayMs). Dipakai
  // wifiTask; MURNI agar dapat diuji terpisah.
  uint32_t nextDelay(uint32_t current) const {
    uint64_t doubled = static_cast<uint64_t>(current) * 2ULL;
    if (doubled > maxDelayMs) {
      return maxDelayMs;
    }
    if (doubled < baseDelayMs) {
      return baseDelayMs;
    }
    return static_cast<uint32_t>(doubled);
  }
};

// ---------------------------------------------------------------------------
// Intent relay: nfcReadTask memutuskan GRANT lalu MENANDAI intent; eksekusi
// fisik + timer penutupan ditangani doorControlTask (pemisahan agar jalur NFC
// tetap cepat & tidak menahan timer). "relay engaged" juga dipakai detektor
// tamper (open tanpa relay => forced open).
// ---------------------------------------------------------------------------
struct RelayIntent {
  volatile bool openRequested = false;  // di-set nfcReadTask / mqttTask (remote unlock)
  volatile uint32_t requestedAtMs = 0;  // millis() permintaan
};

// ---------------------------------------------------------------------------
// AppContext — state bersama antar-task. Dibuat sekali di main.cpp (Task 29)
// dan diteruskan sebagai parameter task (pvParameters). Akses lintas-task
// dilindungi `mutex` untuk field non-atomik (config, snapshot keamanan).
// ---------------------------------------------------------------------------
struct AppContext {
  AppConfig config;        // dimuat dari config.json (Task 24)
  HardwareHooks hooks;     // diisi Task 24/25/26

  // State machine keamanan portabel (lib/security). Transisi murni; state di
  // sini adalah "memori" antar siklus.
  security::BruteForceState bruteForce;  // dipakai nfcReadTask
  security::TamperState tamper;          // dipakai doorControlTask

  // State jaringan.
  WifiBackoff wifi;
  volatile bool wifiConnected = false;   // dibaca mqttTask/syncTask/timeTask
  volatile bool mqttConnected = false;

  // Intent relay (lihat di atas).
  RelayIntent relay;

  // Status relay fisik terkini (true = terbuka) — di-set doorControlTask,
  // dibaca detektor tamper. volatile karena lintas-task.
  volatile bool relayEngaged = false;
  volatile uint32_t relayOpenedAtMs = 0;

  // Flag "WiFi baru pulih" untuk memicu syncTask sekali saat transisi
  // DISCONNECTED->CONNECTED (Req 6.1: sinkron saat pemulihan).
  volatile bool syncRequested = false;

  // --- Event keamanan LIVE tertunda untuk dipublikasikan mqttTask ----------
  // nfcReadTask/doorControlTask MENANDAI event; mqttTask mempublikasikannya ke
  // broker saat online (Req 13.1/13.2). Saat offline, event tetap tercatat di
  // offline_logs.jsonl (jalur kerangka Task 23). Field volatile karena
  // lintas-task; mutex melindungi pembaruan gabungan bruteforce count.
  volatile bool tamperPending = false;       // doorControlTask → mqtt event/tamper
  volatile bool bruteforcePending = false;   // nfcReadTask → mqtt event/bruteforce
  volatile uint32_t bruteforceCount = 0;     // count untuk payload bruteforce

  // --- Log akses LIVE tertunda (REALTIME) untuk dipublikasikan mqttTask -----
  // nfcReadTask menandai hasil tap terakhir; mqttTask mempublikasikannya
  // sebagai log REALTIME saat online (Req 14.1/15.2). Buffer tetap (tanpa heap).
  volatile bool logPending = false;
  char logUid[24] = {0};
  char logResult[16] = {0};
  char logTs[32] = {0};

  // Mutex untuk field gabungan (config, snapshot keamanan). Dibuat di
  // startTasks(). Jalur kritis NFC menghindari menahan mutex lama.
  SemaphoreHandle_t mutex = nullptr;
};

// ---------------------------------------------------------------------------
// Entry point task FreeRTOS. Masing-masing: for(;;) loop non-blocking,
// esp_task_wdt_reset() tiap iterasi, vTaskDelay() sebagai yield (bukan
// delay()). Parameter pv = AppContext*.
// ---------------------------------------------------------------------------
void nfcReadTask(void* pv);       // Tertinggi — verifikasi lokal <200 ms (Req 3.3)
void doorControlTask(void* pv);   // Tinggi   — timer kunci, door-ajar, tamper
void wifiTask(void* pv);          // Sedang   — rekoneksi non-blocking + backoff
void mqttTask(void* pv);          // Sedang   — heartbeat, live log/event, cmd
void syncTask(void* pv);          // Rendah   — push log + pull whitelist delta
void timeTask(void* pv);          // Rendah   — sinkron RTC<->NTP saat online

// ---------------------------------------------------------------------------
// Konfigurasi Task Watchdog Timer (Req 18.4/18.5). Panggil SEKALI di setup()
// sebelum startTasks(). Mengatur timeout watchdog::kTimeoutSeconds dan panic
// reboot otomatis (watchdog::kPanicRebootOnTimeout).
// ---------------------------------------------------------------------------
void setupWatchdog();

// ---------------------------------------------------------------------------
// Buat keenam task dengan prioritas/stack dari app_config.h, inisialisasi
// ctx->mutex, dan DAFTARKAN tiap task ke TWDT (esp_task_wdt_add). Dipanggil
// dari setup() (Task 29) setelah setupWatchdog(). Mengembalikan true bila
// semua task & mutex berhasil dibuat.
// ---------------------------------------------------------------------------
bool startTasks(AppContext* ctx);

}  // namespace app
}  // namespace smartdoor

#endif  // SMARTDOOR_TASKS_H
