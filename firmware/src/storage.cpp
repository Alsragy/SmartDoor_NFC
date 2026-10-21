// ============================================================================
// storage.cpp — Implementasi lapisan penyimpanan LittleFS (Task 24).
//
// FIRMWARE-TARGET (ESP32/Arduino): bergantung pada Arduino.h + LittleFS.h +
// ArduinoJson. TIDAK dikompilasi untuk [env:native]; seluruh isi dijaga di
// balik guard SMARTDOOR_FIRMWARE_TARGET agar test host portabel tetap bersih.
//
// Logika murni (serialisasi JSONL, pruneAcked, applyDelta, dbHash) DIAMBIL
// dari modul portabel lib/ (offline_log, whitelist_delta) untuk paritas dengan
// Web_Server. Modul ini hanya menambah lapisan I/O (baca/tulis/append).
//
// _Requirements: 4.1, 4.2, 4.3, 5.1, 6.3, 6.4, 18.3_
// ============================================================================
#include "storage.h"

// Guard target firmware: aktif saat dibangun untuk ESP32 (Arduino terdefinisi).
// Pada [env:native] (host test) blok hardware tidak ikut dikompilasi.
#if defined(ARDUINO) || defined(ESP32)
#define SMARTDOOR_FIRMWARE_TARGET 1
#endif

#include <algorithm>

#if defined(SMARTDOOR_FIRMWARE_TARGET)
#include <Arduino.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#endif

namespace smartdoor {
namespace storage {

// ---------------------------------------------------------------------------
// KeyCrypto — implementasi DEFAULT pass-through (scaffolding).
//
// PERINGATAN KEAMANAN: ini BUKAN enkripsi. Ia hanya meneruskan nilai apa adanya
// sehingga seam ter-wiring dan whitelist dapat dibaca/ditulis selama
// pengembangan. PRODUKSI WAJIB mengganti via setKeyCrypto() dengan implementasi
// yang memuat device.key dari NVS terenkripsi / flash encryption ESP32 dan
// melakukan AES atas diversified_key (design.md — "Least storage of secrets").
// ---------------------------------------------------------------------------
bool KeyCrypto::encrypt(const std::string& plaintext, std::string& out) const {
  out = plaintext;  // TODO(produksi): AES(enc) + device.key dari NVS terenkripsi.
  return true;
}
bool KeyCrypto::decrypt(const std::string& stored, std::string& out) const {
  out = stored;  // TODO(produksi): AES(dec) + device.key dari NVS terenkripsi.
  return true;
}

namespace {
const KeyCrypto kDefaultCrypto;          // pass-through default
const KeyCrypto* g_crypto = &kDefaultCrypto;
}  // namespace

const KeyCrypto& keyCrypto() { return *g_crypto; }
void setKeyCrypto(const KeyCrypto* crypto) {
  g_crypto = (crypto != nullptr) ? crypto : &kDefaultCrypto;
}

// ===========================================================================
// Di bawah ini: implementasi I/O. Untuk [env:native] (tanpa LittleFS) kita
// sediakan stub yang mengembalikan false/kosong agar tautan tetap berhasil
// bila seseorang keliru menyertakan storage.cpp di build host — meski secara
// default modul ini HANYA dibangun untuk esp32dev.
// ===========================================================================
#if !defined(SMARTDOOR_FIRMWARE_TARGET)

bool begin(bool) { return false; }
size_t freeBytes() { return 0; }
bool exists(const char*) { return false; }
bool readConfig(DeviceConfig&) { return false; }
bool writeConfig(const DeviceConfig&) { return false; }
bool readWhitelist(WhitelistFile&) { return false; }
bool writeWhitelist(const WhitelistFile&) { return false; }
bool lookupCard(const std::string&, WhitelistCard&) { return false; }
bool lookupDiversifiedKey(const std::string&, std::string&) { return false; }
whitelist::Snapshot toDecisionSnapshot(const WhitelistFile&) { return {}; }
bool applyWhitelistDelta(const whitelist::Delta&, whitelist::Snapshot&) { return false; }
bool appendLog(const offline_log::LogEvent&) { return false; }
bool readLogs(std::vector<offline_log::LogEvent>&) { return false; }
bool rewriteLogs(const std::vector<offline_log::LogEvent>&) { return false; }
bool pruneAckedAndPersist(const std::vector<std::string>&) { return false; }
size_t countLogs() { return 0; }
uint64_t loadCounter() { return 0; }
bool storeCounter(uint64_t) { return false; }
std::string nextLogId(const std::string&) { return std::string(); }

#else  // ===================== SMARTDOOR_FIRMWARE_TARGET ======================

namespace {

// Baca seluruh isi berkas teks menjadi std::string. false bila tak ada/gagal.
bool readFileToString(const char* path, std::string& out) {
  File f = LittleFS.open(path, "r");
  if (!f) {
    return false;
  }
  out.clear();
  out.reserve(f.size());
  while (f.available()) {
    out.push_back(static_cast<char>(f.read()));
  }
  f.close();
  return true;
}

// Tulis string ke berkas secara atomik-ish: tulis ke path.tmp lalu rename.
// LittleFS rename menimpa tujuan; ini mengurangi risiko berkas setengah tertulis
// bila daya hilang di tengah penulisan (penting untuk whitelist/config).
bool writeStringAtomic(const char* path, const std::string& data) {
  std::string tmp = std::string(path) + ".tmp";
  {
    File f = LittleFS.open(tmp.c_str(), "w");
    if (!f) {
      return false;
    }
    size_t written = f.write(reinterpret_cast<const uint8_t*>(data.data()),
                             data.size());
    f.close();
    if (written != data.size()) {
      LittleFS.remove(tmp.c_str());
      return false;
    }
  }
  // Rename atomik menggantikan berkas lama.
  if (LittleFS.exists(path)) {
    LittleFS.remove(path);
  }
  return LittleFS.rename(tmp.c_str(), path);
}

}  // namespace

// ---------------------------------------------------------------------------
// Inisialisasi & util
// ---------------------------------------------------------------------------
bool begin(bool formatOnFail) { return LittleFS.begin(formatOnFail); }

size_t freeBytes() {
  // totalBytes - usedBytes = ruang kosong (Req 11.3).
  const size_t total = LittleFS.totalBytes();
  const size_t used = LittleFS.usedBytes();
  return (total > used) ? (total - used) : 0;
}

bool exists(const char* path) { return LittleFS.exists(path); }

// ---------------------------------------------------------------------------
// config.json (Req 17) — kapasitas terukur kConfigJsonCapacity (Req 18.3).
// ---------------------------------------------------------------------------
bool readConfig(DeviceConfig& out) {
  std::string raw;
  if (!readFileToString(kConfigPath(), raw)) {
    return false;
  }
  // ArduinoJson v7 menghapus StaticJsonDocument; pakai JsonDocument default.
  // kConfigJsonCapacity dipertahankan di storage.h sebagai anggaran ukuran
  // terdokumentasi (jalur deserialize sudah menolak input korup/berlebih).
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, raw);
  if (err) {
    return false;  // tolak input berlebih/korup dengan aman (Req 18.3)
  }
  out.lock_open_duration_s = doc["lock_open_duration_s"] | out.lock_open_duration_s;
  out.door_ajar_timeout_s = doc["door_ajar_timeout_s"] | out.door_ajar_timeout_s;
  out.api_key = doc["api_key"] | "";
  JsonObjectConst mqtt = doc["mqtt"].as<JsonObjectConst>();
  if (!mqtt.isNull()) {
    out.mqtt_host = mqtt["host"] | "";
    out.mqtt_port = mqtt["port"] | out.mqtt_port;
    out.mqtt_base_topic = mqtt["base_topic"] | out.mqtt_base_topic;
  }
  // Kredensial WiFi (object "wifi") — RAHASIA, dibaca dari config.json/NVS saat
  // provisioning agar wifiTask dapat menyambung (Req 18.2). Tidak di-hardcode.
  JsonObjectConst wifi = doc["wifi"].as<JsonObjectConst>();
  if (!wifi.isNull()) {
    out.wifi_ssid = wifi["ssid"] | "";
    out.wifi_password = wifi["password"] | "";
  }
  out.whitelist_url = doc["whitelist_url"] | "";
  out.device_id = doc["device_id"] | out.device_id;
  return true;
}

bool writeConfig(const DeviceConfig& config) {
  // ArduinoJson v7 menghapus StaticJsonDocument; pakai JsonDocument default.
  // kConfigJsonCapacity dipertahankan di storage.h sebagai anggaran ukuran
  // terdokumentasi (jalur deserialize sudah menolak input korup/berlebih).
  JsonDocument doc;
  doc["lock_open_duration_s"] = config.lock_open_duration_s;
  doc["door_ajar_timeout_s"] = config.door_ajar_timeout_s;
  doc["api_key"] = config.api_key;
  JsonObject mqtt = doc["mqtt"].to<JsonObject>();
  mqtt["host"] = config.mqtt_host;
  mqtt["port"] = config.mqtt_port;
  mqtt["base_topic"] = config.mqtt_base_topic;
  JsonObject wifi = doc["wifi"].to<JsonObject>();
  wifi["ssid"] = config.wifi_ssid;          // RAHASIA: tetap di config.json/NVS
  wifi["password"] = config.wifi_password;  // RAHASIA: tidak pernah di sumber
  doc["whitelist_url"] = config.whitelist_url;
  doc["device_id"] = config.device_id;

  std::string out;
  if (serializeJson(doc, out) == 0) {
    return false;
  }
  return writeStringAtomic(kConfigPath(), out);
}

// ---------------------------------------------------------------------------
// whitelist.json (Req 4.1/4.2) — kapasitas terukur kWhitelistJsonCapacity.
// ---------------------------------------------------------------------------
bool readWhitelist(WhitelistFile& out) {
  std::string raw;
  if (!readFileToString(kWhitelistPath(), raw)) {
    return false;
  }
  // ArduinoJson v7 menghapus StaticJsonDocument; pakai JsonDocument default.
  // kWhitelistJsonCapacity dipertahankan di storage.h sebagai anggaran ukuran
  // terdokumentasi (jalur deserialize sudah menolak input korup/berlebih).
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, raw);
  if (err) {
    return false;
  }
  out = WhitelistFile{};
  out.db_version = doc["db_version"] | 0;
  out.db_hash = doc["db_hash"] | "";
  JsonArrayConst cards = doc["cards"].as<JsonArrayConst>();
  if (!cards.isNull()) {
    for (JsonObjectConst c : cards) {
      WhitelistCard wc;
      wc.uid = c["uid"] | "";
      // key_version bisa berupa angka atau string di berbagai sumber; normalisasi ke string.
      if (c["key_version"].is<const char*>()) {
        wc.key_version = c["key_version"] | "";
      } else if (c["key_version"].is<int>()) {
        wc.key_version = std::to_string(c["key_version"].as<int>());
      }
      wc.key_params_encrypted = c["key_params"] | "";
      wc.status = c["status"] | "";
      wc.expired_at = c["expired_at"] | "";
      wc.db_version = c["db_version"] | out.db_version;
      out.cards.push_back(std::move(wc));
    }
  }
  return true;
}

bool writeWhitelist(const WhitelistFile& whitelist) {
  // ArduinoJson v7 menghapus StaticJsonDocument; pakai JsonDocument default.
  // kWhitelistJsonCapacity dipertahankan di storage.h sebagai anggaran ukuran
  // terdokumentasi (jalur deserialize sudah menolak input korup/berlebih).
  JsonDocument doc;
  doc["db_version"] = whitelist.db_version;
  doc["db_hash"] = whitelist.db_hash;
  JsonArray cards = doc["cards"].to<JsonArray>();
  for (const WhitelistCard& wc : whitelist.cards) {
    JsonObject c = cards.add<JsonObject>();
    c["uid"] = wc.uid;
    c["key_version"] = wc.key_version;
    c["key_params"] = wc.key_params_encrypted;  // tetap TERENKRIPSI di flash
    c["status"] = wc.status;
    c["expired_at"] = wc.expired_at;
    if (wc.db_version != 0) {
      c["db_version"] = wc.db_version;
    }
  }
  std::string out;
  if (serializeJson(doc, out) == 0) {
    return false;
  }
  return writeStringAtomic(kWhitelistPath(), out);
}

bool lookupCard(const std::string& uid, WhitelistCard& out) {
  WhitelistFile file;
  if (!readWhitelist(file)) {
    return false;
  }
  for (const WhitelistCard& wc : file.cards) {
    if (wc.uid == uid) {
      out = wc;
      return true;
    }
  }
  return false;
}

bool lookupDiversifiedKey(const std::string& uid, std::string& keyPlaintextOut) {
  WhitelistCard wc;
  if (!lookupCard(uid, wc)) {
    return false;
  }
  // DEKRIPSI key_params via seam KeyCrypto — plaintext hanya di memori sesaat.
  return keyCrypto().decrypt(wc.key_params_encrypted, keyPlaintextOut);
}

whitelist::Snapshot toDecisionSnapshot(const WhitelistFile& file) {
  whitelist::Snapshot snap;
  snap.db_version = file.db_version;
  snap.db_hash = file.db_hash;
  snap.cards.reserve(file.cards.size());
  for (const WhitelistCard& wc : file.cards) {
    whitelist::Card c;
    c.uid = wc.uid;
    c.key_version = wc.key_version;
    c.status = wc.status;
    c.expired_at = wc.expired_at;
    c.db_version = wc.db_version;
    snap.cards.push_back(std::move(c));
  }
  return snap;
}

bool applyWhitelistDelta(const whitelist::Delta& delta, whitelist::Snapshot& out) {
  WhitelistFile file;
  if (!readWhitelist(file)) {
    // Tidak ada whitelist lokal: perlakukan sebagai snapshot kosong.
    file = WhitelistFile{};
  }
  const whitelist::Snapshot local = toDecisionSnapshot(file);

  // Terapkan delta + verifikasi db_hash (lib portabel — Property 7, Req 4.3).
  whitelist::Snapshot applied;
  const bool consistent = whitelist::applyDeltaVerified(local, delta, applied);
  out = applied;
  if (!consistent) {
    // Hash tak cocok → jangan timpa berkas; pemanggil dapat fallback full sync.
    return false;
  }

  // Petakan kembali snapshot ke WhitelistFile, mempertahankan key_params
  // terenkripsi untuk kartu yang masih ada dan menyalin dari delta.changed.
  WhitelistFile next;
  next.db_version = applied.db_version;
  next.db_hash = applied.db_hash;
  next.cards.reserve(applied.cards.size());

  for (const whitelist::Card& c : applied.cards) {
    WhitelistCard wc;
    wc.uid = c.uid;
    wc.key_version = c.key_version;
    wc.status = c.status;
    wc.expired_at = c.expired_at;
    wc.db_version = c.db_version;

    // Prioritas key_params: dari kartu lama tersimpan, kalau tidak ada belum
    // tersedia (delta logika murni tidak membawa key material). syncTask dapat
    // melengkapi key_params via provisioning/whitelist penuh bila diperlukan.
    for (const WhitelistCard& old : file.cards) {
      if (old.uid == c.uid) {
        wc.key_params_encrypted = old.key_params_encrypted;
        break;
      }
    }
    next.cards.push_back(std::move(wc));
  }
  return writeWhitelist(next);
}

// ---------------------------------------------------------------------------
// offline_logs.jsonl (Req 5.1) — append-only, satu baris JSON per event.
// ---------------------------------------------------------------------------
bool appendLog(const offline_log::LogEvent& event) {
  std::string line;
  if (!offline_log::serialize(event, line)) {  // lib portabel (Property 8)
    return false;
  }
  File f = LittleFS.open(kOfflineLogsPath(), "a");  // append-only (Req 5.1)
  if (!f) {
    return false;
  }
  size_t n = f.write(reinterpret_cast<const uint8_t*>(line.data()), line.size());
  f.write(static_cast<uint8_t>('\n'));  // satu objek per baris
  f.close();
  return n == line.size();
}

bool readLogs(std::vector<offline_log::LogEvent>& out) {
  out.clear();
  File f = LittleFS.open(kOfflineLogsPath(), "r");
  if (!f) {
    return true;  // antrean kosong = sukses dengan 0 entri
  }
  std::string line;
  while (f.available()) {
    char ch = static_cast<char>(f.read());
    if (ch == '\n') {
      if (!line.empty()) {
        offline_log::LogEvent ev;
        // Tahan korupsi parsial: lewati baris yang gagal parse (Req 5.1).
        if (offline_log::parse(line, ev)) {
          out.push_back(std::move(ev));
        }
      }
      line.clear();
    } else if (ch != '\r') {
      line.push_back(ch);
    }
  }
  // Baris terakhir tanpa newline penutup.
  if (!line.empty()) {
    offline_log::LogEvent ev;
    if (offline_log::parse(line, ev)) {
      out.push_back(std::move(ev));
    }
  }
  f.close();
  return true;
}

bool rewriteLogs(const std::vector<offline_log::LogEvent>& events) {
  std::string buf;
  for (const offline_log::LogEvent& ev : events) {
    std::string line;
    if (!offline_log::serialize(ev, line)) {
      return false;
    }
    buf += line;
    buf.push_back('\n');
  }
  return writeStringAtomic(kOfflineLogsPath(), buf);
}

bool pruneAckedAndPersist(const std::vector<std::string>& ackedIds) {
  std::vector<offline_log::LogEvent> queue;
  if (!readLogs(queue)) {
    return false;
  }
  // pruneAcked = antrean awal − id ber-ACK (lib portabel — Property 9, Req 6.3).
  std::vector<offline_log::LogEvent> pruned =
      offline_log::pruneAcked(queue, ackedIds);
  return rewriteLogs(pruned);
}

size_t countLogs() {
  std::vector<offline_log::LogEvent> queue;
  if (!readLogs(queue)) {
    return 0;
  }
  return queue.size();
}

// ---------------------------------------------------------------------------
// Counter idempotency persisten (Req 6.4) — pola write-ahead.
// ---------------------------------------------------------------------------
uint64_t loadCounter() {
  std::string raw;
  if (!readFileToString(kCounterPath(), raw)) {
    return 0;
  }
  // Parse angka desimal sederhana; abaikan whitespace.
  uint64_t value = 0;
  for (char ch : raw) {
    if (ch >= '0' && ch <= '9') {
      value = value * 10 + static_cast<uint64_t>(ch - '0');
    } else if (ch == '\n' || ch == '\r' || ch == ' ') {
      if (value > 0) break;
    } else {
      break;
    }
  }
  return value;
}

bool storeCounter(uint64_t value) {
  return writeStringAtomic(kCounterPath(), std::to_string(value));
}

std::string nextLogId(const std::string& deviceId) {
  const uint64_t current = loadCounter();
  // peekNext (lib portabel): hitung id berikut + nilai counter berikut TANPA mutasi.
  offline_log::NextId n = offline_log::peekNext(deviceId, current);
  // Write-ahead: persist counter baru DULU agar crash tidak menyebabkan reuse id.
  if (!storeCounter(n.nextCounter)) {
    return std::string();
  }
  return n.id;
}

#endif  // SMARTDOOR_FIRMWARE_TARGET

}  // namespace storage
}  // namespace smartdoor
