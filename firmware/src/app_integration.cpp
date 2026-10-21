// ============================================================================
// app_integration.cpp — Implementasi wiring Task 24 → kerangka task (Task 23).
//
// Menyediakan implementasi hook (NowIsoFn/NtpSyncFn/EnqueueLogLineFn) yang
// didukung storage.h (LittleFS) & rtc_time.h (DS3231 + NTP), plus helper
// storage-backed untuk syncTask (Task 27.2). Semua panggilan hardware berada di
// balik fungsi yang jelas sehingga logika portabel tetap dapat diuji.
//
// FIRMWARE-TARGET: dijaga guard SMARTDOOR_FIRMWARE_TARGET. Stub host tetap
// disediakan agar tautan berhasil bila keliru disertakan di build native.
//
// _Requirements: 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 5.5, 6.3_
// ============================================================================
#include "app_integration.h"

#if defined(ARDUINO) || defined(ESP32)
#define SMARTDOOR_FIRMWARE_TARGET 1
#endif

#include <cstring>

#include "rtc_time.h"
#include "whitelist_delta.h"

namespace smartdoor {
namespace app {

// ---------------------------------------------------------------------------
// Hook: NowIsoFn — timestamp ISO-8601 UTC dari RTC (Req 5.2/5.4).
// ---------------------------------------------------------------------------
size_t hookNowIso(char* out, size_t cap) {
  if (out == nullptr || cap == 0) {
    return 0;
  }
  const std::string ts = rtc_time::nowIso8601Utc();
  const size_t n = (ts.size() < cap - 1) ? ts.size() : (cap - 1);
  std::memcpy(out, ts.data(), n);
  out[n] = '\0';
  return n;
}

// ---------------------------------------------------------------------------
// Hook: NtpSyncFn — sinkron RTC dari NTP saat online (Req 5.3).
// ---------------------------------------------------------------------------
bool hookNtpSync() { return rtc_time::syncRtcFromNtp(); }

// ---------------------------------------------------------------------------
// Hook: EnqueueLogLineFn — append satu baris JSONL ke offline_logs.jsonl.
//
// Baris sudah diserialisasi pemanggil (offline_log::serialize). Kita parse
// kembali agar dapat: (a) memakai jalur append aman storage::appendLog, dan
// (b) menandai ts_unverified=1 bila RTC melaporkan jam tak andal saat event
// dibuat (Req 5.5) sementara pemanggil belum menyetelnya. Tahan korupsi: baris
// yang gagal parse di-drop dengan aman (Req 5.1).
// ---------------------------------------------------------------------------
void hookEnqueueLogLine(const char* jsonlLine) {
  if (jsonlLine == nullptr) {
    return;
  }
  offline_log::LogEvent ev;
  if (!offline_log::parse(std::string(jsonlLine), ev)) {
    return;  // baris tak valid: drop dengan aman
  }
  // Req 5.5: bila jam tidak andal (RTC lostPower & belum resync NTP), tandai
  // timestamp sebagai tidak terverifikasi agar audit trail jujur.
  if (!rtc_time::isTimeReliable()) {
    ev.has_ts_unverified = true;
    ev.ts_unverified = 1;
  }
  storage::appendLog(ev);  // append-only (Req 5.1)
}

// ---------------------------------------------------------------------------
// setupStorageAndTime — mount FS, muat config, init RTC, pasang hook.
// ---------------------------------------------------------------------------
bool setupStorageAndTime(AppContext& ctx) {
  bool ok = true;

  // 1) LittleFS.
  const bool fsOk = storage::begin(/*formatOnFail=*/true);
  ok = ok && fsOk;

  // 2) config.json → ctx.config (Req 17 / 7). Hanya menimpa bila baca sukses.
  if (fsOk) {
    storage::DeviceConfig cfg;
    if (storage::readConfig(cfg)) {
      ctx.config.setLockOpenSeconds(cfg.lock_open_duration_s);   // Req 17.1
      ctx.config.setDoorAjarSeconds(cfg.door_ajar_timeout_s);    // Req 17.2
      std::strncpy(ctx.config.apiKey, cfg.api_key.c_str(),
                   sizeof(ctx.config.apiKey) - 1);
      std::strncpy(ctx.config.deviceId, cfg.device_id.c_str(),
                   sizeof(ctx.config.deviceId) - 1);
      std::strncpy(ctx.config.mqtt.host, cfg.mqtt_host.c_str(),
                   sizeof(ctx.config.mqtt.host) - 1);
      ctx.config.mqtt.port = cfg.mqtt_port;
      std::strncpy(ctx.config.mqtt.baseTopic, cfg.mqtt_base_topic.c_str(),
                   sizeof(ctx.config.mqtt.baseTopic) - 1);
      // Kredensial WiFi dari config.json → ctx.config.wifi agar wifiTask dapat
      // WiFi.begin() (rekoneksi non-blocking, Req 18.2). RAHASIA: bersumber dari
      // berkas/NVS, tidak di-hardcode di firmware.
      std::strncpy(ctx.config.wifi.ssid, cfg.wifi_ssid.c_str(),
                   sizeof(ctx.config.wifi.ssid) - 1);
      std::strncpy(ctx.config.wifi.password, cfg.wifi_password.c_str(),
                   sizeof(ctx.config.wifi.password) - 1);
      std::strncpy(ctx.config.whitelistUrl, cfg.whitelist_url.c_str(),
                   sizeof(ctx.config.whitelistUrl) - 1);
    } else {
      ok = false;  // config absen/korup: default aman tetap dipakai
    }
  }

  // 3) RTC DS3231 (Req 5.2). lostPower() dievaluasi di begin() → reliabilitas.
  const bool rtcOk = rtc_time::begin();
  ok = ok && rtcOk;

  // 4) Pasang hook Task 24 ke seam kerangka task.
  ctx.hooks.nowIso = &hookNowIso;             // Req 5.2/5.4 (nfcReadTask)
  ctx.hooks.ntpSync = &hookNtpSync;           // Req 5.3 (timeTask)
  ctx.hooks.enqueueLogLine = &hookEnqueueLogLine;  // Req 5.1 (nfcReadTask)

  return ok;
}

// ---------------------------------------------------------------------------
// syncTask helpers (Task 27.2) — storage-backed.
// ---------------------------------------------------------------------------
bool drainOfflineLogsForUpload(std::vector<offline_log::LogEvent>& out) {
  return storage::readLogs(out);  // Req 6.2
}

bool confirmUploadedLogs(const std::vector<std::string>& ackedIds) {
  return storage::pruneAckedAndPersist(ackedIds);  // Req 6.3
}

bool applyWhitelistDeltaJson(const std::string& deltaJson,
                             whitelist::Snapshot& out) {
  whitelist::Delta delta;
  if (!whitelist::parseDeltaJson(deltaJson, delta)) {  // lib portabel
    return false;
  }
  // applyDeltaVerified (verifikasi db_hash) + persist ke LittleFS (Req 4.3).
  return storage::applyWhitelistDelta(delta, out);
}

int64_t currentWhitelistVersion() {
  storage::WhitelistFile file;
  if (!storage::readWhitelist(file)) {
    return 0;  // belum ada whitelist lokal → setara full fetch (since_version=0)
  }
  return file.db_version;
}

}  // namespace app
}  // namespace smartdoor
