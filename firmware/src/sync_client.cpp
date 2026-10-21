// ============================================================================
// sync_client.cpp — Implementasi klien REST delta-sync & ingest (Task 27.2).
// Smart Door KOS ESP32. Lihat sync_client.h untuk kontrak & pemisahan MQTT/REST.
//
// Alur runSyncOnce() (design.md "Alur Delta Sync saat Pemulihan WiFi"):
//   1) PUSH offline logs — drain antrean → build body { logs:[...] } berbatas →
//      POST (X-API-Key) → parse { accepted_ids } → confirmUploadedLogs(ackedIds)
//      (hapus TEPAT entri ber-ACK; sisanya aman dikirim ulang karena idempoten).
//   2) PULL whitelist delta — GET ?since_version=N (X-API-Key) →
//      applyWhitelistDeltaJson (applyDeltaVerified + persist, verifikasi db_hash).
//      Bila verifikasi gagal → fallback full fetch (since_version=0).
//
// ArduinoJson v7: body upload & parse respons memakai JsonDocument ber-Allocator
// kapasitas TETAP (BoundedAllocator) — pola yang sama seperti tasks.cpp — agar
// alokasi GAGAL AMAN (bukan menghabiskan heap) saat input melebihi batas
// (Req 18.3). Tidak ada DynamicJsonDocument tak-berbatas.
//
// Transport HTTP default (ESP32) memakai HTTPClient + WiFiClient dengan timeout
// (kHttpTimeoutMs) dan dibatasi guard SMARTDOOR_FIRMWARE_TARGET; build host
// memakai HttpTransport yang diinjeksi (tidak menautkan HTTPClient).
//
// _Requirements: 6.1, 6.2, 6.3, 6.4, 4.3, 7.2, 7.3_
// ============================================================================
#include "sync_client.h"

#if defined(ARDUINO) || defined(ESP32)
#define SMARTDOOR_FIRMWARE_TARGET 1
#endif

#include <ArduinoJson.h>

#include <algorithm>
#include <cstddef>
#include <cstring>
#include <vector>

#include "app_integration.h"  // drain/confirm/applyWhitelistDeltaJson/currentWhitelistVersion
#include "offline_log.h"

#if defined(SMARTDOOR_FIRMWARE_TARGET)
#include <HTTPClient.h>
#include <WiFiClient.h>
#endif

namespace smartdoor {
namespace app {

namespace {

// ===========================================================================
// Allocator ArduinoJson berkapasitas TETAP (Req 18.3) — identik pola tasks.cpp.
// Alokasi melebihi kapasitas mengembalikan nullptr (gagal aman) alih-alih
// memakai heap tanpa batas. Bump allocator cukup untuk dokumen berumur pendek.
// ===========================================================================
class BoundedAllocator : public ArduinoJson::Allocator {
 public:
  BoundedAllocator(uint8_t* buffer, size_t capacity)
      : buffer_(buffer), capacity_(capacity), used_(0) {}

  void* allocate(size_t size) override {
    const size_t aligned = (size + sizeof(void*) - 1) & ~(sizeof(void*) - 1);
    if (used_ + aligned > capacity_) {
      return nullptr;  // batas tercapai → gagal aman (Req 18.3)
    }
    void* ptr = buffer_ + used_;
    used_ += aligned;
    return ptr;
  }

  void* reallocate(void* /*ptr*/, size_t newSize) override {
    return allocate(newSize);
  }

  void deallocate(void* /*ptr*/) override { /* no-op: direset per dokumen */ }

 private:
  uint8_t* buffer_;
  size_t capacity_;
  size_t used_;
};

// Potong trailing slash agar penggabungan URL tidak menghasilkan "//".
std::string stripTrailingSlash(std::string s) {
  while (!s.empty() && s.back() == '/') {
    s.pop_back();
  }
  return s;
}

}  // namespace

// ===========================================================================
// Pembentukan URL
// ===========================================================================

std::string deriveBaseUrl(const AppConfig& config) {
  // whitelistUrl config berbentuk, mis.:
  //   "http://10.0.0.5:3000/api/devices/dev01/whitelist"
  // Base = bagian sebelum "/api/devices/". Bila pola tak ditemukan namun URL
  // tetap ada, pakai apa adanya (sudah di-strip slash). Bila kosong → "".
  const std::string url = config.whitelistUrl;
  if (url.empty()) {
    return std::string();
  }
  const std::string marker = "/api/devices/";
  const size_t pos = url.find(marker);
  if (pos != std::string::npos) {
    return stripTrailingSlash(url.substr(0, pos));
  }
  return stripTrailingSlash(url);
}

std::string buildOfflineLogsUrl(const std::string& baseUrl,
                                const std::string& deviceId) {
  return stripTrailingSlash(baseUrl) + "/api/devices/" + deviceId +
         "/offline-logs";
}

std::string buildWhitelistUrl(const std::string& baseUrl,
                              const std::string& deviceId,
                              int64_t sinceVersion) {
  return stripTrailingSlash(baseUrl) + "/api/devices/" + deviceId +
         "/whitelist?since_version=" + std::to_string(sinceVersion);
}

// ===========================================================================
// Transport HTTP default ESP32 (hanya firmware-target)
// ===========================================================================
#if defined(SMARTDOOR_FIRMWARE_TARGET)
namespace {

// Salin body respons ke string dengan BATAS kMaxResponseBytes (Req 18.3).
// Mengembalikan false bila melebihi batas (gagal aman).
bool readBodyBounded(HTTPClient& http, std::string& out) {
  const int len = http.getSize();
  if (len > 0 && static_cast<size_t>(len) > sync_limits::kMaxResponseBytes) {
    return false;  // terlalu besar → tolak tanpa mengalokasikan
  }
  String payload = http.getString();  // HTTPClient membatasi pada Content-Length
  if (payload.length() > sync_limits::kMaxResponseBytes) {
    return false;
  }
  out.assign(payload.c_str(), payload.length());
  return true;
}

}  // namespace

// Transport konkret: HTTPClient + WiFiClient, timeout-bounded.
class Esp32HttpTransport : public HttpTransport {
 public:
  HttpResponse postJson(const std::string& url, const std::string& apiKey,
                        const std::string& body) override {
    HttpResponse resp;
    WiFiClient client;
    HTTPClient http;
    if (!http.begin(client, url.c_str())) {
      return resp;  // ok=false: gagal transport
    }
    http.setTimeout(sync_limits::kHttpTimeoutMs);        // batas baca
    http.setConnectTimeout(sync_limits::kHttpTimeoutMs); // batas connect
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-API-Key", apiKey.c_str());         // Req 7.3
    const int code = http.POST(
        reinterpret_cast<const uint8_t*>(body.data()), body.size());
    if (code <= 0) {
      http.end();
      return resp;  // ok=false: timeout / tak tersambung
    }
    resp.statusCode = code;
    if (!readBodyBounded(http, resp.body)) {
      http.end();
      return resp;  // ok=false: body melebihi batas
    }
    resp.ok = true;
    http.end();
    return resp;
  }

  HttpResponse get(const std::string& url, const std::string& apiKey) override {
    HttpResponse resp;
    WiFiClient client;
    HTTPClient http;
    if (!http.begin(client, url.c_str())) {
      return resp;
    }
    http.setTimeout(sync_limits::kHttpTimeoutMs);
    http.setConnectTimeout(sync_limits::kHttpTimeoutMs);
    http.addHeader("X-API-Key", apiKey.c_str());  // Req 7.3
    const int code = http.GET();
    if (code <= 0) {
      http.end();
      return resp;
    }
    resp.statusCode = code;
    if (!readBodyBounded(http, resp.body)) {
      http.end();
      return resp;
    }
    resp.ok = true;
    http.end();
    return resp;
  }
};
#endif  // SMARTDOOR_FIRMWARE_TARGET

// ===========================================================================
// Builder body upload offline-logs (berbatas, Req 18.3)
// ===========================================================================
namespace {

// Bangun { "logs": [ {id, ts, uid, result, sync_type, ts_unverified?}, ... ] }
// dari hingga `maxCount` entri pertama `events`. `includedIds` diisi id entri
// yang disertakan (untuk korelasi accepted_ids). Mengembalikan true bila sukses
// & muat dalam buffer berbatas.
bool buildUploadBody(const std::vector<offline_log::LogEvent>& events,
                     size_t maxCount, std::string& outBody,
                     std::vector<std::string>& includedIds) {
  uint8_t pool[sync_limits::kUploadDocCapacity];
  BoundedAllocator alloc(pool, sizeof(pool));
  JsonDocument doc(&alloc);  // dibatasi pool (Req 18.3)

  JsonArray logs = doc["logs"].to<JsonArray>();
  includedIds.clear();

  const size_t n = (events.size() < maxCount) ? events.size() : maxCount;
  for (size_t i = 0; i < n; ++i) {
    const offline_log::LogEvent& ev = events[i];
    // Entri tanpa id tak dapat di-ACK secara idempoten — lewati (tetap di
    // antrean). Server mengidentifikasi via idempotency_key.
    if (ev.id.empty()) {
      continue;
    }
    JsonObject o = logs.add<JsonObject>();
    o["id"] = ev.id;
    o["ts"] = ev.ts;
    o["uid"] = ev.uid;
    o["result"] = ev.result;
    o["sync_type"] = ev.sync_type;
    if (ev.has_ts_unverified) {
      o["ts_unverified"] = ev.ts_unverified;
    }
    includedIds.push_back(ev.id);
  }

  if (doc.overflowed()) {
    // Alokasi mencapai batas pool → body tidak lengkap. Gagal aman: pemanggil
    // dapat mencoba batch lebih kecil pada siklus berikut (entri tetap utuh).
    outBody.clear();
    includedIds.clear();
    return false;
  }

  outBody.clear();
  serializeJson(doc, outBody);
  return !includedIds.empty();
}

// Parse respons ACK { "accepted_ids": [...] } → daftar id. Toleran: field
// hilang/null → daftar kosong. Mengembalikan false hanya bila JSON tak valid.
bool parseAckResponse(const std::string& body,
                      std::vector<std::string>& ackedIds) {
  uint8_t pool[sync_limits::kUploadDocCapacity];
  BoundedAllocator alloc(pool, sizeof(pool));
  JsonDocument doc(&alloc);
  const DeserializationError err = deserializeJson(doc, body);
  if (err) {
    return false;
  }
  ackedIds.clear();
  JsonArrayConst arr = doc["accepted_ids"].as<JsonArrayConst>();
  if (!arr.isNull()) {
    for (JsonVariantConst v : arr) {
      const char* s = v.as<const char*>();
      if (s != nullptr) {
        ackedIds.emplace_back(s);
      }
    }
  }
  return true;
}

}  // namespace

// ===========================================================================
// Langkah 1 — PUSH offline logs (Req 6.1/6.2/6.3/6.4)
// ===========================================================================
namespace {

void pushOfflineLogs(AppContext& ctx, HttpTransport& transport,
                     const std::string& baseUrl, SyncResult& result) {
  std::vector<offline_log::LogEvent> queue;
  if (!drainOfflineLogsForUpload(queue)) {
    return;  // gagal baca FS → coba lagi siklus berikut (antrean utuh)
  }
  if (queue.empty()) {
    result.uploadOk = true;  // tidak ada yang perlu dikirim: sukses trivial
    return;
  }

  const std::string url = buildOfflineLogsUrl(baseUrl, ctx.config.deviceId);
  const std::string apiKey = ctx.config.apiKey;

  // Kirim dalam batch berbatas (kMaxLogsPerBatch). Hanya hapus entri yang
  // BENAR-BENAR ter-ACK oleh server; entri sisa/ gagal tetap di antrean dan
  // aman dikirim ulang (idempoten — Req 6.4).
  size_t offset = 0;
  bool anyBatchOk = false;
  while (offset < queue.size()) {
    std::vector<offline_log::LogEvent> slice(
        queue.begin() + static_cast<std::ptrdiff_t>(offset),
        queue.begin() +
            static_cast<std::ptrdiff_t>(
                std::min(offset + sync_limits::kMaxLogsPerBatch, queue.size())));

    std::string body;
    std::vector<std::string> includedIds;
    if (!buildUploadBody(slice, sync_limits::kMaxLogsPerBatch, body,
                         includedIds)) {
      break;  // body tak terbangun (kosong/overflow) → hentikan push siklus ini
    }

    const HttpResponse resp = transport.postJson(url, apiKey, body);
    if (!resp.ok || resp.statusCode < 200 || resp.statusCode >= 300) {
      break;  // gagal transport / non-2xx → berhenti; retry siklus berikut
    }

    std::vector<std::string> ackedIds;
    if (!parseAckResponse(resp.body, ackedIds)) {
      break;  // ACK tak valid → jangan hapus apa pun (aman)
    }

    anyBatchOk = true;
    result.logsUploaded += includedIds.size();

    if (!ackedIds.empty()) {
      // Hapus TEPAT entri ber-ACK dari antrean persist (Req 6.3). pruneAcked
      // mengabaikan id yang tidak ada → aman untuk ACK subset.
      if (confirmUploadedLogs(ackedIds)) {
        result.logsAcked += ackedIds.size();
      }
    }

    offset += sync_limits::kMaxLogsPerBatch;
  }

  result.uploadOk = anyBatchOk;
}

// ===========================================================================
// Langkah 2 — PULL whitelist delta (Req 4.3/7.2)
// ===========================================================================
void pullWhitelistDelta(AppContext& ctx, HttpTransport& transport,
                        const std::string& baseUrl, SyncResult& result) {
  const std::string apiKey = ctx.config.apiKey;
  const int64_t since = currentWhitelistVersion();  // db_version lokal (Req 4.3)

  const std::string url =
      buildWhitelistUrl(baseUrl, ctx.config.deviceId, since);
  HttpResponse resp = transport.get(url, apiKey);
  if (!resp.ok || resp.statusCode < 200 || resp.statusCode >= 300) {
    return;  // gagal / non-2xx → whitelist lokal tetap dipakai (offline-first)
  }
  result.whitelistFetched = true;

  // Terapkan delta + verifikasi db_hash (Req 4.3). applyWhitelistDeltaJson
  // mengembalikan false bila parse gagal ATAU db_hash tidak cocok.
  whitelist::Snapshot snap;
  if (applyWhitelistDeltaJson(resp.body, snap)) {
    result.deltaApplied = true;
    result.newDbVersion = snap.db_version;
    return;
  }

  // --- Fallback full fetch (since_version=0) bila verifikasi db_hash gagal ---
  // Delta mungkin tidak konsisten (mis. lewat beberapa versi / state lokal
  // menyimpang). Tarik ulang dari NOL: `?since_version=0` memakai jalur DELTA
  // server (bukan whitelist penuh tanpa parameter) sehingga respons tetap
  // berbentuk { changed, removed, db_version, db_hash } — kompatibel dengan
  // parseDeltaJson. Dengan changed = seluruh kartu aktif & removed sesuai,
  // apply atas snapshot lokal menghasilkan db_hash server (Property 7).
  const std::string fullUrl =
      buildWhitelistUrl(baseUrl, ctx.config.deviceId, 0);
  HttpResponse full = transport.get(fullUrl, apiKey);
  if (!full.ok || full.statusCode < 200 || full.statusCode >= 300) {
    return;  // fallback gagal → pertahankan whitelist lokal saat ini
  }
  result.usedFullFallback = true;

  whitelist::Snapshot snapFull;
  if (applyWhitelistDeltaJson(full.body, snapFull)) {
    result.deltaApplied = true;
    result.newDbVersion = snapFull.db_version;
  }
}

}  // namespace

// ===========================================================================
// runSyncOnce — orkestrasi satu siklus (push → pull)
// ===========================================================================
SyncResult runSyncOnce(AppContext& ctx, HttpTransport* transport) {
  SyncResult result;

  // Tanpa link tidak ada yang bisa disinkronkan (dipanggil syncTask hanya saat
  // wifiConnected, tetapi jaga tetap aman bila dipanggil lain).
  if (!ctx.wifiConnected) {
    return result;
  }

  const std::string baseUrl = deriveBaseUrl(ctx.config);
  if (baseUrl.empty()) {
    return result;  // URL belum terkonfigurasi → lewati sync REST dengan aman
  }

  // Pilih transport: yang diinjeksi (uji) atau default ESP32 (firmware-target).
  HttpTransport* tx = transport;
#if defined(SMARTDOOR_FIRMWARE_TARGET)
  Esp32HttpTransport defaultTransport;
  if (tx == nullptr) {
    tx = &defaultTransport;
  }
#endif
  if (tx == nullptr) {
    return result;  // tak ada transport (host tanpa injeksi) → no-op aman
  }

  result.attempted = true;

  // Urutan sesuai design.md: unggah log dulu, lalu tarik whitelist delta.
  pushOfflineLogs(ctx, *tx, baseUrl, result);
  pullWhitelistDelta(ctx, *tx, baseUrl, result);

  return result;
}

}  // namespace app
}  // namespace smartdoor
