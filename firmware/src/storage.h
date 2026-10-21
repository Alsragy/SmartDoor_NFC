// ============================================================================
// storage.h — Lapisan penyimpanan LittleFS untuk Smart Door KOS ESP32.
//
// Task 24 — Integrasi penyimpanan LittleFS. Modul ini adalah lapisan I/O
// FIRMWARE-TARGET (Arduino/ESP32 + LittleFS + ArduinoJson): TIDAK portabel ke
// host [env:native] karena bergantung pada FS.h/LittleFS.h. Logika murni
// (serialisasi/parse, delta, dedupe) tetap berada di modul portabel di lib/
// (whitelist_delta, offline_log) dan dipakai ulang di sini untuk menjaga
// paritas perilaku dengan Web_Server.
//
// Tata letak LittleFS (design.md — "Tata Letak LittleFS"):
//   /whitelist.json        — daftar kartu valid + status + expired_at + versi/hash DB
//   /offline_logs.jsonl    — antrean log (append-only, satu JSON per baris)
//   /config.json           — parameter pintu + jaringan
//   /device.key            — kunci enkripsi lokal pelindung diversified_key
//
// Prinsip desain:
//   - Panggilan hardware (LittleFS) disembunyikan di balik fungsi yang jelas
//     sehingga logika portabel tetap dapat diuji di host.
//   - Dokumen ArduinoJson DIBATASI ukurannya (StaticJsonDocument / kapasitas
//     terukur) untuk mencegah gagal alokasi heap (Req 18.3).
//   - offline_logs.jsonl bersifat APPEND-ONLY, satu objek JSON per baris
//     (tahan korupsi parsial — Req 5.1).
//   - diversified_key per kartu disimpan TERENKRIPSI; enkripsi/dekripsi
//     dilakukan via seam encrypt/decrypt (lihat KeyCrypto) yang dalam PRODUKSI
//     wajib memakai NVS terenkripsi / flash encryption ESP32 — firmware TIDAK
//     pernah menyimpan Master_Key (design.md — "Least storage of secrets").
//
// _Requirements: 4.1, 4.2, 5.1, 5.2_
// ============================================================================
#ifndef SMARTDOOR_STORAGE_H
#define SMARTDOOR_STORAGE_H

#include <cstddef>
#include <string>
#include <vector>

#include "offline_log.h"      // lib/offline_log — LogEvent + serialize/parse/prune (portabel)
#include "whitelist_delta.h"  // lib/whitelist   — Snapshot/Delta + applyDelta/dbHash (portabel)

namespace smartdoor {
namespace storage {

// ---------------------------------------------------------------------------
// Lintasan berkas kanonik di LittleFS (design.md — "Tata Letak LittleFS").
// ---------------------------------------------------------------------------
inline const char* kWhitelistPath() { return "/whitelist.json"; }
inline const char* kOfflineLogsPath() { return "/offline_logs.jsonl"; }
inline const char* kConfigPath() { return "/config.json"; }
inline const char* kDeviceKeyPath() { return "/device.key"; }
inline const char* kCounterPath() { return "/idempotency.ctr"; }

// Batas kapasitas dokumen ArduinoJson (Req 18.3). Nilai konservatif agar
// alokasi pada heap ESP32 aman; disetel di satu tempat untuk audit mudah.
inline constexpr size_t kConfigJsonCapacity = 1024;     // config.json kecil
inline constexpr size_t kWhitelistJsonCapacity = 16384; // whitelist (≈ puluhan kartu)
inline constexpr size_t kLogLineJsonCapacity = 512;     // satu baris JSONL

// ---------------------------------------------------------------------------
// Konfigurasi pintu + jaringan (shape config.json — design.md).
// Dipakai doorControlTask (durasi relay / door-ajar) & networking (mqtt/url).
// ---------------------------------------------------------------------------
struct DeviceConfig {
  uint32_t lock_open_duration_s = 5;   // Req 17.1 — durasi relay terbuka
  uint32_t door_ajar_timeout_s = 30;   // Req 17.2 — ambang alarm door-ajar
  std::string api_key;                 // Req 7.3 — disertakan di tiap payload
  std::string mqtt_host;
  uint16_t mqtt_port = 1883;
  std::string mqtt_base_topic = "smartdoor";
  std::string whitelist_url;           // endpoint unduh whitelist/delta
  std::string device_id = "dev01";     // id perangkat (prefix idempotency key)

  // Kredensial WiFi (object "wifi" di config.json). RAHASIA: dimuat dari
  // config.json/NVS saat provisioning, TIDAK di-hardcode di sumber. wifiTask
  // memakai nilai ini untuk WiFi.begin() (rekoneksi non-blocking, Req 18.2).
  std::string wifi_ssid;
  std::string wifi_password;
};

// ---------------------------------------------------------------------------
// KeyCrypto — SEAM enkripsi/dekripsi diversified_key (design.md — "Least
// storage of secrets"). `key_params` di whitelist.json menyimpan diversified
// key TERENKRIPSI (base64) dengan device.key. Modul storage memanggil hook ini
// saat membaca/menulis sehingga kunci dalam bentuk plaintext hanya ada di
// memori sesaat.
//
// IMPLEMENTASI DEFAULT di storage.cpp adalah PASS-THROUGH (identitas) yang
// HANYA menandai batas kripto — ia TIDAK mengenkripsi apa pun. PRODUKSI WAJIB
// menyediakan implementasi nyata yang:
//   - memuat device.key dari NVS terenkripsi / flash encryption ESP32
//     (bukan berkas datar), dan
//   - melakukan AES (mis. AES-GCM via mbedtls) atas diversified_key.
// Firmware TIDAK pernah menyimpan Master_Key.
//
// Dibiarkan sebagai interface agar mudah disuntik tanpa menyentuh I/O lain.
// ---------------------------------------------------------------------------
struct KeyCrypto {
  // Enkripsi plaintext diversified key -> representasi tersimpan (base64 dsb.).
  // Default (pass-through) hanya untuk scaffolding; lihat catatan di atas.
  virtual bool encrypt(const std::string& plaintext, std::string& out) const;
  // Dekripsi representasi tersimpan -> plaintext diversified key.
  virtual bool decrypt(const std::string& stored, std::string& out) const;
  virtual ~KeyCrypto() = default;
};

// Ambil seam KeyCrypto aktif (default: pass-through). Pemanggil produksi dapat
// mengganti dengan setKeyCrypto() saat boot sebelum operasi whitelist.
const KeyCrypto& keyCrypto();
void setKeyCrypto(const KeyCrypto* crypto);

// ---------------------------------------------------------------------------
// WhitelistCard — representasi satu kartu sebagaimana TERSIMPAN di
// whitelist.json, termasuk `key_params` terenkripsi. Berbeda dari
// whitelist::Card (yang hanya memuat field relevan hash) agar key material
// tidak bocor ke lapisan logika murni.
// ---------------------------------------------------------------------------
struct WhitelistCard {
  std::string uid;
  std::string key_version;
  std::string key_params_encrypted;  // base64(enc(diversified_key)) — Req 4.1
  std::string status;                // "ACTIVE" | "SUSPENDED"
  std::string expired_at;            // ISO-8601 UTC
  int64_t db_version = 0;
};

struct WhitelistFile {
  int64_t db_version = 0;
  std::string db_hash;  // "sha256:<hex>"
  std::vector<WhitelistCard> cards;
};

// ---------------------------------------------------------------------------
// Inisialisasi & util filesystem
// ---------------------------------------------------------------------------

// Mount LittleFS (format bila perlu pada first boot). Harus dipanggil sekali di
// setup() sebelum operasi lain. Mengembalikan true bila FS siap.
bool begin(bool formatOnFail = true);

// Ruang kosong LittleFS (byte) — dipakai heartbeat (fs_free, Req 11.3).
size_t freeBytes();

// true bila berkas ada.
bool exists(const char* path);

// ---------------------------------------------------------------------------
// config.json (Req 17) — baca/tulis parameter pintu + jaringan.
// ArduinoJson dengan kapasitas terukur (kConfigJsonCapacity, Req 18.3).
// ---------------------------------------------------------------------------
bool readConfig(DeviceConfig& out);
bool writeConfig(const DeviceConfig& config);

// ---------------------------------------------------------------------------
// whitelist.json (Req 4.1/4.2) — sumber keputusan akses lokal.
//   readWhitelist   : muat seluruh snapshot (key_params tetap terenkripsi).
//   writeWhitelist  : simpan snapshot (mis. setelah applyDelta).
//   lookupDiversifiedKey : cari kartu by uid, DEKRIPSI key_params via KeyCrypto
//                          sehingga nfcReadTask mendapat diversified key plaintext
//                          di memori sesaat untuk verifikasi kripto (Req 1.3).
//   toDecisionSnapshot   : proyeksikan ke whitelist::Snapshot (lib portabel)
//                          untuk verifikasi db_hash & keputusan akses.
//   applyDeltaAndPersist : terapkan whitelist::Delta (lib portabel) ke snapshot
//                          tersimpan, verifikasi db_hash, lalu persist (Req 4.3).
// ---------------------------------------------------------------------------
bool readWhitelist(WhitelistFile& out);
bool writeWhitelist(const WhitelistFile& whitelist);

bool lookupCard(const std::string& uid, WhitelistCard& out);
bool lookupDiversifiedKey(const std::string& uid, std::string& keyPlaintextOut);

// Proyeksi ke snapshot logika murni (uid/status/expired_at/key_version/db_version).
whitelist::Snapshot toDecisionSnapshot(const WhitelistFile& file);

// Terapkan delta (changed/removed) ke whitelist tersimpan, verifikasi db_hash,
// lalu simpan bila konsisten. `out` diisi snapshot hasil apply. Mengembalikan
// true iff db_hash cocok DAN penyimpanan sukses (Req 4.3). Bila hash tak cocok,
// tidak menimpa berkas (pemanggil dapat fallback full sync).
bool applyWhitelistDelta(const whitelist::Delta& delta, whitelist::Snapshot& out);

// ---------------------------------------------------------------------------
// offline_logs.jsonl (Req 5.1) — antrean log APPEND-ONLY, satu baris per event.
//   appendLog   : serialkan (lib portabel) + tambahkan satu baris '\n'.
//   readLogs    : baca & parse seluruh antrean (lewati baris korup — tahan
//                 korupsi parsial).
//   rewriteLogs : tulis ulang antrean (dipakai setelah pruneAcked di syncTask).
//   pruneAckedAndPersist : baca → pruneAcked(lib portabel) → rewrite (Req 6.3).
//   countLogs   : jumlah baris valid (untuk telemetri/batas).
// ---------------------------------------------------------------------------
bool appendLog(const offline_log::LogEvent& event);
bool readLogs(std::vector<offline_log::LogEvent>& out);
bool rewriteLogs(const std::vector<offline_log::LogEvent>& events);
bool pruneAckedAndPersist(const std::vector<std::string>& ackedIds);
size_t countLogs();

// ---------------------------------------------------------------------------
// Counter idempotency persisten (Req 6.4) — nilai monotonik lintas reboot.
// Pola write-ahead (peekNext di lib portabel): persist dulu nilai counter baru
// SEBELUM memakai id, agar tidak pernah ada reuse id setelah crash.
//   loadCounter   : baca nilai counter (0 bila belum ada).
//   storeCounter  : simpan nilai counter.
//   nextLogId     : bentuk id berikut (deviceId-counter), persist counter baru,
//                   kembalikan id. Mengembalikan string kosong bila gagal persist.
// ---------------------------------------------------------------------------
uint64_t loadCounter();
bool storeCounter(uint64_t value);
std::string nextLogId(const std::string& deviceId);

}  // namespace storage
}  // namespace smartdoor

#endif  // SMARTDOOR_STORAGE_H
