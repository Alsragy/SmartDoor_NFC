// ============================================================================
// mqtt_client.cpp — Implementasi klien MQTT firmware (Task 27.1).
// Smart Door KOS ESP32. Lihat mqtt_client.h untuk kontrak & tata letak topik.
//
// Prinsip:
//   - FAIL-CLOSED api_key (Req 7.4): tiap perintah masuk divalidasi; payload
//     tanpa api_key valid DIABAIKAN. api_key disuntik di tiap payload terbit
//     (Req 7.3).
//   - ArduinoJson DIBATASI (Req 18.3): BoundedAllocator berkapasitas tetap +
//     buffer serialisasi berukuran tetap di stack (tanpa heap tak-berbatas;
//     v7 menghapus StaticJsonDocument).
//   - Dispatch perintah menyentuh SEAM (AppContext/relay/intent, storage)
//     bukan hardware langsung (paritas dengan kerangka Task 23).
//
// _Requirements: 7.1, 7.3, 7.4, 9.2, 9.3, 10.1, 10.2, 10.3, 11.1, 12.2, 12.3,
//                13.1, 13.2, 14.1, 17.3, 18.3_
// ============================================================================

#include "mqtt_client.h"

#include <ArduinoJson.h>
#include <WiFi.h>

#include <cstring>

#include "storage.h"           // freeBytes, readWhitelist/writeWhitelist (Req 11/9/10)
#include "whitelist_delta.h"   // dbHash atas kartu aktif (parity server, Req 4.3)

namespace smartdoor {
namespace app {

namespace {

// Kapasitas dokumen/payload MQTT (Req 18.3). Cukup untuk field terbesar
// (heartbeat + cmd/config) dengan margin string; payload besar (whitelist
// penuh) TIDAK lewat jalur ini (ditangani syncTask via REST streaming).
constexpr size_t kMqttDocCapacity = 512;
constexpr size_t kTopicCapacity = 96;   // "smartdoor/{dev}/event/bruteforce"
constexpr size_t kPayloadCapacity = 512;

// Jeda minimum antar percobaan konek broker (non-blocking, tidak memblok task).
constexpr uint32_t kReconnectIntervalMs = 5000;

// --- Subtopik kanonik (paritas src/constants.js MQTT_SUBTOPIC) --------------
constexpr const char* kSubHeartbeat = "heartbeat";
constexpr const char* kSubLog = "log";
constexpr const char* kSubEventTamper = "event/tamper";
constexpr const char* kSubEventBruteforce = "event/bruteforce";
constexpr const char* kSubCmdUnlock = "cmd/unlock";
constexpr const char* kSubCmdRevoke = "cmd/revoke";
constexpr const char* kSubCmdSuspend = "cmd/suspend";
constexpr const char* kSubCmdConfig = "cmd/config";
constexpr const char* kBaseTopic = "smartdoor";

// Allocator berkapasitas TETAP (Req 18.3): bump allocator atas buffer statis;
// alokasi melebihi kapasitas mengembalikan nullptr (ArduinoJson menanganinya
// sebagai kegagalan alokasi yang aman) alih-alih memakai heap tak-berbatas.
// Paritas dengan BoundedAllocator di tasks.cpp — disalin lokal agar modul ini
// mandiri (tidak mengekspor simbol internal tasks.cpp).
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
    return allocate(newSize);  // dokumen berumur pendek per pesan
  }

  void deallocate(void* /*ptr*/) override { /* no-op: direset per dokumen */ }

 private:
  uint8_t* buffer_;
  size_t capacity_;
  size_t used_;
};

// Instance aktif untuk thunk callback statik PubSubClient. Satu klien per
// perangkat (satu ESP32 per pintu — design.md), jadi pointer tunggal cukup.
MqttClient* g_active = nullptr;

// db_version whitelist tersimpan (Req 11.1). 0 bila belum ada whitelist.
int64_t readDbVersion() {
  storage::WhitelistFile file;
  if (!storage::readWhitelist(file)) {
    return 0;
  }
  return file.db_version;
}

// Hitung ulang db_hash atas kartu AKTIF (paritas server, Req 4.3) lalu simpan.
// Dipakai setelah revoke/suspend memutasi whitelist agar db_version/db_hash
// tetap konsisten untuk delta sync berikutnya.
bool recomputeHashAndPersist(storage::WhitelistFile& file) {
  const whitelist::Snapshot snap = storage::toDecisionSnapshot(file);
  // dbHash hanya atas kartu aktif; toDecisionSnapshot mempertahankan status.
  file.db_hash = whitelist::dbHash(whitelist::activeCards(snap.cards));
  file.db_version = file.db_version + 1;  // monotonik setelah mutasi lokal
  for (auto& c : file.cards) {
    c.db_version = file.db_version;
  }
  return storage::writeWhitelist(file);
}

}  // namespace

// ===========================================================================
// Pembandingan api_key waktu-konstan (Req 7.4)
// ===========================================================================
bool apiKeyMatches(const char* expected, const char* provided) {
  if (expected == nullptr || provided == nullptr) {
    return false;
  }
  const size_t le = std::strlen(expected);
  const size_t lp = std::strlen(provided);
  // Kunci kosong dikonfigurasi dianggap "tidak tervalidasi" → fail-closed.
  if (le == 0) {
    return false;
  }
  // Akumulasi perbedaan tanpa short-circuit (waktu-konstan terhadap isi).
  // Panjang berbeda langsung gagal, tetapi tetap pindai salah satu untuk
  // menyamakan jalur biaya sebisanya.
  uint8_t diff = static_cast<uint8_t>(le ^ lp);
  const size_t n = (le < lp) ? le : lp;
  for (size_t i = 0; i < n; ++i) {
    diff |= static_cast<uint8_t>(expected[i] ^ provided[i]);
  }
  return diff == 0 && le == lp;
}

MqttClient* activeMqttClient() { return g_active; }

// ===========================================================================
// Siklus hidup koneksi
// ===========================================================================
void MqttClient::begin(AppContext* ctx) {
  ctx_ = ctx;
  g_active = this;
  mqtt_.setServer(ctx_->config.mqtt.host, ctx_->config.mqtt.port);
  mqtt_.setCallback(&MqttClient::onMessageThunk);
  // Perbesar buffer PubSubClient agar muat payload terukur kita (default 256).
  mqtt_.setBufferSize(kPayloadCapacity);
  subscribed_ = false;
}

bool MqttClient::connect() {
  if (ctx_ == nullptr) {
    return false;
  }
  if (mqtt_.connected()) {
    return true;
  }
  // Backoff non-blocking: jangan membebani broker / memblok task.
  const uint32_t now = millis();
  if (lastConnectAttemptMs_ != 0 &&
      (now - lastConnectAttemptMs_) < kReconnectIntervalMs) {
    return false;
  }
  lastConnectAttemptMs_ = now;

  // Client id = deviceId (unik per pintu). Tanpa kredensial broker di sini;
  // autentikasi aplikasi dilakukan via api_key payload (Req 7.3/7.4).
  const bool ok = mqtt_.connect(ctx_->config.deviceId);
  if (!ok) {
    subscribed_ = false;
    return false;
  }

  // Subscribe keempat topik perintah milik perangkat ini (Server→Firmware).
  char topic[kTopicCapacity];
  const char* cmds[] = {kSubCmdUnlock, kSubCmdRevoke, kSubCmdSuspend,
                        kSubCmdConfig};
  subscribed_ = true;
  for (const char* sub : cmds) {
    if (buildTopic(sub, topic, sizeof(topic)) > 0) {
      subscribed_ &= mqtt_.subscribe(topic);
    }
  }
  return true;
}

bool MqttClient::loop() {
  if (ctx_ == nullptr) {
    return false;
  }
  if (!mqtt_.connected()) {
    connect();  // coba sambung (rate-limited); tetap non-blocking
  }
  mqtt_.loop();  // keep-alive + pump pesan masuk → onMessageThunk
  return mqtt_.connected();
}

// ===========================================================================
// Util topik & publish
// ===========================================================================
size_t MqttClient::buildTopic(const char* subtopic, char* out,
                              size_t cap) const {
  // "smartdoor/{dev}/<subtopic>" — base selalu "smartdoor" (constants.js).
  const int n = snprintf(out, cap, "%s/%s/%s", kBaseTopic, ctx_->config.deviceId,
                         subtopic);
  if (n <= 0 || static_cast<size_t>(n) >= cap) {
    return 0;  // terpotong → jangan kirim topik tak valid
  }
  return static_cast<size_t>(n);
}

bool MqttClient::publishTo(const char* subtopic, const char* payload,
                           size_t len) {
  if (!mqtt_.connected()) {
    return false;
  }
  char topic[kTopicCapacity];
  if (buildTopic(subtopic, topic, sizeof(topic)) == 0) {
    return false;
  }
  return mqtt_.publish(topic, reinterpret_cast<const uint8_t*>(payload),
                       static_cast<unsigned int>(len), /*retained=*/false);
}

// ===========================================================================
// Publishers (api_key di tiap payload — Req 7.3)
// ===========================================================================
bool MqttClient::publishHeartbeat() {
  if (ctx_ == nullptr) {
    return false;
  }
  uint8_t pool[kMqttDocCapacity];
  BoundedAllocator alloc(pool, sizeof(pool));
  JsonDocument doc(&alloc);

  doc["device_id"] = ctx_->config.deviceId;
  doc["rssi"] = ctx_->wifiConnected ? WiFi.RSSI() : 0;            // Req 11.1
  doc["fs_free"] = static_cast<uint32_t>(storage::freeBytes());   // Req 11.3
  doc["db_version"] = readDbVersion();                            // Req 11.1
  char ts[32] = {0};
  if (ctx_->hooks.nowIso != nullptr) {
    ctx_->hooks.nowIso(ts, sizeof(ts));
  }
  doc["ts"] = ts;
  doc["api_key"] = ctx_->config.apiKey;                          // Req 7.3

  char payload[kPayloadCapacity];
  const size_t n = serializeJson(doc, payload, sizeof(payload));
  if (n == 0 || n >= sizeof(payload)) {
    return false;
  }
  return publishTo(kSubHeartbeat, payload, n);
}

bool MqttClient::publishLog(const char* uid, const char* result,
                            const char* ts) {
  if (ctx_ == nullptr) {
    return false;
  }
  uint8_t pool[kMqttDocCapacity];
  BoundedAllocator alloc(pool, sizeof(pool));
  JsonDocument doc(&alloc);

  doc["device_id"] = ctx_->config.deviceId;
  doc["uid"] = (uid != nullptr) ? uid : "";
  doc["result"] = (result != nullptr) ? result : "";
  doc["ts"] = (ts != nullptr) ? ts : "";
  doc["sync_type"] = "REALTIME";               // Req 14.1 / 15.2 (live)
  doc["api_key"] = ctx_->config.apiKey;        // Req 7.3

  char payload[kPayloadCapacity];
  const size_t n = serializeJson(doc, payload, sizeof(payload));
  if (n == 0 || n >= sizeof(payload)) {
    return false;
  }
  return publishTo(kSubLog, payload, n);
}

bool MqttClient::publishTamper(const char* ts) {
  if (ctx_ == nullptr) {
    return false;
  }
  uint8_t pool[kMqttDocCapacity];
  BoundedAllocator alloc(pool, sizeof(pool));
  JsonDocument doc(&alloc);

  doc["device_id"] = ctx_->config.deviceId;
  doc["ts"] = (ts != nullptr) ? ts : "";
  doc["api_key"] = ctx_->config.apiKey;        // Req 7.3

  char payload[kPayloadCapacity];
  const size_t n = serializeJson(doc, payload, sizeof(payload));
  if (n == 0 || n >= sizeof(payload)) {
    return false;
  }
  return publishTo(kSubEventTamper, payload, n);  // Req 13.2
}

bool MqttClient::publishBruteforce(uint32_t count, const char* ts) {
  if (ctx_ == nullptr) {
    return false;
  }
  uint8_t pool[kMqttDocCapacity];
  BoundedAllocator alloc(pool, sizeof(pool));
  JsonDocument doc(&alloc);

  doc["device_id"] = ctx_->config.deviceId;
  doc["count"] = count;
  doc["ts"] = (ts != nullptr) ? ts : "";
  doc["api_key"] = ctx_->config.apiKey;        // Req 7.3

  char payload[kPayloadCapacity];
  const size_t n = serializeJson(doc, payload, sizeof(payload));
  if (n == 0 || n >= sizeof(payload)) {
    return false;
  }
  return publishTo(kSubEventBruteforce, payload, n);  // Req 13.1
}

// ===========================================================================
// Pesan masuk: callback + validasi api_key + dispatch
// ===========================================================================
void MqttClient::onMessageThunk(char* topic, uint8_t* payload,
                                unsigned int len) {
  if (g_active != nullptr) {
    g_active->handleMessage(topic, payload, len);
  }
}

void MqttClient::handleMessage(const char* topic, const uint8_t* payload,
                               unsigned int len) {
  if (ctx_ == nullptr || topic == nullptr) {
    return;
  }

  // Parse payload JSON dalam dokumen terukur (Req 18.3).
  uint8_t pool[kMqttDocCapacity];
  BoundedAllocator alloc(pool, sizeof(pool));
  JsonDocument doc(&alloc);
  const DeserializationError err = deserializeJson(doc, payload, len);
  if (err) {
    return;  // payload korup/terlalu besar → abaikan (fail-closed)
  }

  // VALIDASI api_key SEBELUM efek apa pun (Req 7.4, fail-closed). Perintah
  // tanpa api_key valid diabaikan total.
  const char* provided = doc["api_key"] | static_cast<const char*>(nullptr);
  if (!apiKeyMatches(ctx_->config.apiKey, provided)) {
    return;
  }

  // Cocokkan subtopik perintah (suffix setelah "smartdoor/{dev}/").
  // Bandingkan ekor topik agar tahan prefix device.
  auto endsWith = [](const char* s, const char* suffix) -> bool {
    const size_t ls = std::strlen(s);
    const size_t lf = std::strlen(suffix);
    return ls >= lf && std::strcmp(s + (ls - lf), suffix) == 0;
  };

  if (endsWith(topic, kSubCmdUnlock)) {
    handleUnlock();  // Req 12.2/12.3
  } else if (endsWith(topic, kSubCmdRevoke)) {
    const char* uid = doc["uid"] | static_cast<const char*>(nullptr);
    if (uid != nullptr && uid[0] != '\0') {
      handleRevoke(uid);  // Req 10.1/10.2/10.3
    }
  } else if (endsWith(topic, kSubCmdSuspend)) {
    const char* uid = doc["uid"] | static_cast<const char*>(nullptr);
    if (uid != nullptr && uid[0] != '\0') {
      handleSuspend(uid);  // Req 9.2/9.3
    }
  } else if (endsWith(topic, kSubCmdConfig)) {
    const bool hasLock = doc["lock_open_duration_s"].is<uint32_t>() ||
                         doc["lock_open_duration_s"].is<int>();
    const bool hasAjar = doc["door_ajar_timeout_s"].is<uint32_t>() ||
                         doc["door_ajar_timeout_s"].is<int>();
    const uint32_t lockS = doc["lock_open_duration_s"] | 0U;
    const uint32_t ajarS = doc["door_ajar_timeout_s"] | 0U;
    handleConfig(hasLock, lockS, hasAjar, ajarS);  // Req 17.3
  }
  // Topik lain (mis. cmd/ota) tidak ditangani di Task 27.1.
}

// ===========================================================================
// Handler perintah (dipanggil HANYA setelah api_key tervalidasi)
// ===========================================================================

// cmd/unlock → set intent relay (Req 12.2/12.3). Tidak menyentuh hardware
// langsung: doorControlTask yang mengeksekusi relay + timer penutupan.
void MqttClient::handleUnlock() {
  ctx_->relay.requestedAtMs = millis();
  ctx_->relay.openRequested = true;
  // Umpan balik live (design.md Remote Unlock): log REMOTE_UNLOCK (Req 14.1).
  char ts[32] = {0};
  if (ctx_->hooks.nowIso != nullptr) {
    ctx_->hooks.nowIso(ts, sizeof(ts));
  }
  publishLog("", "REMOTE_UNLOCK", ts);
}

// cmd/revoke → hapus uid dari whitelist (Req 10.1/10.2) sehingga tap berikut
// DITOLAK (Req 10.3: kartu tak dikenal → DENY di nfcReadTask).
void MqttClient::handleRevoke(const char* uid) {
  storage::WhitelistFile file;
  if (!storage::readWhitelist(file)) {
    return;  // tak ada whitelist lokal → tidak ada yang dihapus
  }
  bool removed = false;
  for (auto it = file.cards.begin(); it != file.cards.end();) {
    if (it->uid == uid) {
      it = file.cards.erase(it);  // hapus total (Req 10.2)
      removed = true;
    } else {
      ++it;
    }
  }
  if (removed) {
    recomputeHashAndPersist(file);
  }
}

// cmd/suspend → set status kartu SUSPENDED (Req 9.2); nfcReadTask/lib decision
// menolak akses kartu Suspended (Req 9.3).
void MqttClient::handleSuspend(const char* uid) {
  storage::WhitelistFile file;
  if (!storage::readWhitelist(file)) {
    return;
  }
  bool changed = false;
  for (auto& c : file.cards) {
    if (c.uid == uid && c.status != whitelist::status::kSuspended()) {
      c.status = whitelist::status::kSuspended();
      changed = true;
    }
  }
  if (changed) {
    recomputeHashAndPersist(file);
  }
}

// cmd/config → perbarui parameter pintu (Req 17.3). Nilai detik dikonversi ke
// ms agar langsung dipakai doorControlTask. Field yang tidak dikirim tidak
// diubah.
void MqttClient::handleConfig(bool hasLock, uint32_t lockSeconds, bool hasAjar,
                              uint32_t ajarSeconds) {
  if (hasLock) {
    ctx_->config.setLockOpenSeconds(lockSeconds);  // Lock_Open_Duration
  }
  if (hasAjar) {
    ctx_->config.setDoorAjarSeconds(ajarSeconds);  // Door_Ajar_Timeout
  }
  // Persist ke config.json agar bertahan reboot (best-effort; Task 24 storage).
  storage::DeviceConfig dc;
  if (storage::readConfig(dc)) {
    if (hasLock) {
      dc.lock_open_duration_s = lockSeconds;
    }
    if (hasAjar) {
      dc.door_ajar_timeout_s = ajarSeconds;
    }
    storage::writeConfig(dc);
  }
}

}  // namespace app
}  // namespace smartdoor
