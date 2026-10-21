// ============================================================================
// mqtt_client.h — Klien MQTT firmware (Task 27.1) — Smart Door KOS ESP32.
//
// Lapisan FIRMWARE-TARGET (Arduino/ESP32): memakai WiFiClient + PubSubClient +
// ArduinoJson v7. TIDAK portabel ke [env:native] (bergantung WiFi.h /
// PubSubClient.h / storage.h). Logika keputusan tetap di lib/ portabel; modul
// ini hanya "lem" transport MQTT + dispatch perintah ke SEAM AppContext.
//
// Peran (design.md "Desain Topik MQTT"):
//   Firmware→Server (publish):
//     smartdoor/{dev}/heartbeat        { rssi, fs_free, db_version, ts, api_key }  Req 11.1
//     smartdoor/{dev}/log              { uid, result, ts, sync_type:"REALTIME", api_key } Req 14.1/15.2
//     smartdoor/{dev}/event/tamper     { ts, api_key }                             Req 13.2
//     smartdoor/{dev}/event/bruteforce { count, ts, api_key }                      Req 13.1
//   Server→Firmware (subscribe):
//     smartdoor/{dev}/cmd/unlock       { nonce, api_key }        → intent relay     Req 12.2/12.3
//     smartdoor/{dev}/cmd/revoke       { uid, api_key }          → hapus uid+deny   Req 10.1/10.2/10.3
//     smartdoor/{dev}/cmd/suspend      { uid, api_key }          → status SUSPENDED Req 9.2/9.3
//     smartdoor/{dev}/cmd/config       { lock_open_duration_s, door_ajar_timeout_s, api_key } Req 17.3
//
// KEAMANAN (Req 7.3/7.4 — FAIL-CLOSED): `api_key` disertakan di SETIAP payload
// terbit, dan DIVALIDASI di setiap perintah masuk. Perintah dengan api_key
// hilang/salah DIABAIKAN tanpa efek samping. Perbandingan api_key memakai
// pembandingan waktu-konstan (lihat apiKeyMatches) untuk mengurangi kebocoran
// via timing.
//
// ArduinoJson DIBATASI (Req 18.3): tiap publish/parse memakai dokumen dengan
// backing allocator berkapasitas TETAP (BoundedAllocator) + buffer serialisasi
// berukuran tetap di stack. Tidak ada dokumen tak-berbatas (v7 menghapus
// StaticJsonDocument).
//
// Integrasi mqttTask (tasks.cpp):
//   - connect()          : dipanggil saat WiFi tersambung tapi broker belum
//                          konek (rate-limited via backoff internal, non-blocking).
//   - loop()             : dipanggil tiap iterasi untuk keep-alive PubSubClient
//                          + memproses pesan masuk (callback → handler perintah).
//   - publishHeartbeat() : dipanggil berkala (period::kHeartbeatMs).
//   - publishLog/Tamper/Bruteforce : dipanggil saat event live terjadi.
//
// _Requirements: 7.1, 7.3, 7.4, 9.2, 9.3, 10.1, 10.2, 10.3, 11.1, 12.2, 12.3,
//                13.1, 13.2, 14.1, 17.3, 18.3_
// ============================================================================
#ifndef SMARTDOOR_MQTT_CLIENT_H
#define SMARTDOOR_MQTT_CLIENT_H

#include <Arduino.h>
#include <PubSubClient.h>
#include <WiFiClient.h>

#include <cstddef>
#include <cstdint>

#include "tasks.h"  // smartdoor::app::AppContext (SEAM relay/config/hooks)

namespace smartdoor {
namespace app {

// ---------------------------------------------------------------------------
// Pembandingan api_key waktu-konstan (Req 7.4). Mengembalikan true iff kedua
// string identik (panjang + isi). Dibuat tidak bergantung pada posisi byte
// pertama yang berbeda agar mengurangi kebocoran timing. Aman untuk nullptr.
// ---------------------------------------------------------------------------
bool apiKeyMatches(const char* expected, const char* provided);

// ---------------------------------------------------------------------------
// MqttClient — bungkus PubSubClient untuk satu perangkat. Dibuat sekali
// (statik di mqttTask) dan memegang pointer ke AppContext agar handler
// perintah dapat menyetel intent relay / memutasi whitelist via storage.
// ---------------------------------------------------------------------------
class MqttClient {
 public:
  MqttClient() = default;

  // Pasang konteks aplikasi + siapkan PubSubClient (server, buffer, callback).
  // Dipanggil sekali sebelum loop pertama. Idempoten.
  void begin(AppContext* ctx);

  // Jalankan keep-alive + proses pesan masuk (NON-BLOCKING). Dipanggil tiap
  // iterasi mqttTask saat WiFi tersambung. Mengembalikan true bila broker
  // terhubung setelah loop.
  bool loop();

  // Coba konek ke broker bila belum terhubung (rate-limited backoff internal,
  // NON-BLOCKING-friendly). Saat sukses, subscribe keempat topik cmd/*.
  // Mengembalikan true bila terhubung (baru atau sudah).
  bool connect();

  bool connected() const { return mqtt_.connected(); }

  // --- Publishers (api_key disuntik di tiap payload — Req 7.3) --------------

  // heartbeat: { device_id, rssi, fs_free, db_version, ts, api_key } (Req 11.1).
  // rssi via WiFi.RSSI(); fs_free via storage::freeBytes(); db_version via
  // whitelist tersimpan; ts via hook nowIso.
  bool publishHeartbeat();

  // log live (REALTIME): { device_id, uid, result, ts, sync_type:"REALTIME",
  // api_key } (Req 14.1/15.2). `result` mis. "GRANT"/"DENY"/"REMOTE_UNLOCK".
  bool publishLog(const char* uid, const char* result, const char* ts);

  // event tamper: { device_id, ts, api_key } (Req 13.2).
  bool publishTamper(const char* ts);

  // event brute-force: { device_id, count, ts, api_key } (Req 13.1).
  bool publishBruteforce(uint32_t count, const char* ts);

 private:
  // Callback PubSubClient (statik agar cocok tanda tangan C). Mendispatch ke
  // instance aktif (ada satu klien per perangkat).
  static void onMessageThunk(char* topic, uint8_t* payload, unsigned int len);

  // Handler pesan masuk sesungguhnya: validasi api_key lalu dispatch per topik.
  void handleMessage(const char* topic, const uint8_t* payload, unsigned int len);

  // Handler perintah individual (dipanggil hanya SETELAH api_key tervalidasi).
  void handleUnlock();                      // Req 12.2/12.3
  void handleRevoke(const char* uid);       // Req 10.1/10.2/10.3
  void handleSuspend(const char* uid);      // Req 9.2/9.3
  void handleConfig(bool hasLock, uint32_t lockSeconds,
                    bool hasAjar, uint32_t ajarSeconds);  // Req 17.3

  // Susun topik penuh "smartdoor/{dev}/<sub>" ke buffer `out`.
  size_t buildTopic(const char* subtopic, char* out, size_t cap) const;

  // Terbitkan payload ke subtopik (mengembalikan hasil PubSubClient::publish).
  bool publishTo(const char* subtopic, const char* payload, size_t len);

  AppContext* ctx_ = nullptr;
  WiFiClient net_;
  PubSubClient mqtt_{net_};
  uint32_t lastConnectAttemptMs_ = 0;  // backoff reconnect non-blocking
  bool subscribed_ = false;
};

// Akses instance aktif (dipakai thunk callback). Null bila belum begin().
MqttClient* activeMqttClient();

}  // namespace app
}  // namespace smartdoor

#endif  // SMARTDOOR_MQTT_CLIENT_H
