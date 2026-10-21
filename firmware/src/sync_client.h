// ============================================================================
// sync_client.h — Klien REST delta-sync & ingest offline-log untuk syncTask
// (Task 27.2) — Smart Door KOS ESP32.
//
// Mengimplementasikan "Alur Delta Sync saat Pemulihan WiFi" (design.md, Req 6):
// saat WiFi pulih (ctx.syncRequested di tasks.cpp), syncTask memanggil
// runSyncOnce() yang melakukan DUA langkah berurutan, keduanya menyertakan
// API_Key di setiap request (header X-API-Key, Req 7.3):
//
//   1) PUSH offline logs (Req 6.1/6.2/6.3/6.4)
//        POST <base>/api/devices/:dev/offline-logs
//        body: { "logs": [ {id, ts, uid, result, sync_type, ts_unverified?}, ... ] }
//      → parse ACK { "accepted_ids": [...] } lalu confirmUploadedLogs(ackedIds)
//        yang menghapus TEPAT entri ber-ACK (offline_log::pruneAcked). Entri
//        yang TIDAK ter-ACK tetap di antrean; karena id bersifat idempotency
//        key, pengiriman ulang aman (server INSERT ... ON CONFLICT DO NOTHING).
//
//   2) PULL whitelist delta (Req 4.3/7.2)
//        GET <base>/api/devices/:dev/whitelist?since_version=N
//        (N = db_version lokal saat ini)
//      → applyWhitelistDeltaJson(body) → applyDeltaVerified (verifikasi db_hash)
//        + persist. Bila verifikasi db_hash GAGAL, fallback full fetch dengan
//        since_version=0 lalu terapkan ulang.
//
// MQTT vs REST (pemisahan transport):
//   - MQTT (mqttTask, Task 27.1): jalur REAL-TIME selama online — heartbeat,
//     live log (sync_type=REALTIME), event tamper/brute-force, dan menerima
//     perintah cmd/unlock|revoke|suspend|config. Bersifat push/pub-sub, latensi
//     rendah, dipakai saat perangkat ONLINE.
//   - REST (syncTask, modul INI): jalur REKONSILIASI saat PEMULIHAN dari
//     offline — mengunggah antrean log yang tertahan selama offline dan menarik
//     delta whitelist untuk menyusul versi server. Bersifat request/response,
//     idempoten, dipicu sekali per transisi DISCONNECTED->CONNECTED.
//   Keduanya memakai API_Key; keduanya tidak boleh memblok nfcReadTask.
//
// NON-BLOCKING / TIMEOUT-BOUNDED (Req 18): syncTask berprioritas RENDAH dan
// TIDAK boleh menahan jalur kritis NFC. Transport HTTP WAJIB memiliki timeout
// (kHttpTimeoutMs) agar runSyncOnce() tidak menggantung. Keseluruhan satu
// siklus sync dibatasi jumlah batch & ukuran body (Req 18.3).
//
// TESTABILITAS: HTTP diabstraksikan di balik `HttpTransport` (seam) sehingga
// seluruh alur sync dapat diuji di host tanpa jaringan. Transport default
// ESP32 (HTTPClient + WiFiClient) disediakan di sync_client.cpp di balik guard
// SMARTDOOR_FIRMWARE_TARGET.
//
// _Requirements: 6.1, 6.2, 6.3, 6.4, 4.3, 7.2, 7.3_
// ============================================================================
#ifndef SMARTDOOR_SYNC_CLIENT_H
#define SMARTDOOR_SYNC_CLIENT_H

#include <cstdint>
#include <string>

#include "app_config.h"
#include "tasks.h"  // smartdoor::app::AppContext

namespace smartdoor {
namespace app {

// ---------------------------------------------------------------------------
// Batas-batas sync (Req 18.3) — JSON & jaringan dibatasi agar deterministik.
// ---------------------------------------------------------------------------
namespace sync_limits {

// Timeout tiap request HTTP (ms). syncTask prioritas rendah; request yang
// menggantung tidak boleh menahan siklus sync. Harus < jendela TWDT agar
// feedWatchdog() di syncTask tetap terjadi tepat waktu.
inline constexpr uint32_t kHttpTimeoutMs = 4000;

// Jumlah entri log maksimum per batch POST. Antrean lebih besar diunggah dalam
// beberapa batch; sisanya tetap di antrean (idempoten → aman dikirim ulang).
inline constexpr size_t kMaxLogsPerBatch = 32;

// Kapasitas backing-store Allocator ArduinoJson untuk BODY upload offline-log
// satu batch (Req 18.3). Dihitung konservatif dari kMaxLogsPerBatch entri.
inline constexpr size_t kUploadDocCapacity = 8192;

// Batas ukuran body respons yang diterima (byte). Respons delta whitelist yang
// melebihi batas ini ditolak dengan aman (bukan menghabiskan heap).
inline constexpr size_t kMaxResponseBytes = 16384;

}  // namespace sync_limits

// ---------------------------------------------------------------------------
// HttpTransport — SEAM HTTP (Req testabilitas). Dua kata kerja yang dibutuhkan
// alur sync: POST JSON dan GET. Implementasi default ESP32 memakai HTTPClient +
// WiFiClient dengan timeout; implementasi uji host dapat memalsukan respons.
//
// Kontrak:
//   - Mengembalikan true bila transaksi HTTP selesai & statusCode terisi
//     (termasuk status non-2xx — pemanggil memeriksa statusCode). Mengembalikan
//     false hanya bila gagal transport (tak tersambung / timeout / body
//     melebihi kMaxResponseBytes).
//   - `apiKey` disetel sebagai header X-API-Key pada SETIAP request (Req 7.3).
//   - Semua panggilan WAJIB timeout-bounded (kHttpTimeoutMs).
// ---------------------------------------------------------------------------
struct HttpResponse {
  bool ok = false;          // true bila transaksi selesai (lihat kontrak di atas)
  int statusCode = 0;       // kode HTTP (mis. 200, 400, 404, 500)
  std::string body;         // body respons (dibatasi kMaxResponseBytes)
};

class HttpTransport {
 public:
  virtual ~HttpTransport() = default;

  // POST `body` (application/json) ke `url` dengan header X-API-Key: apiKey.
  virtual HttpResponse postJson(const std::string& url,
                                const std::string& apiKey,
                                const std::string& body) = 0;

  // GET `url` dengan header X-API-Key: apiKey.
  virtual HttpResponse get(const std::string& url,
                           const std::string& apiKey) = 0;
};

// ---------------------------------------------------------------------------
// Hasil satu siklus sync (untuk telemetri/log; syncTask mengabaikan nilai
// detail selain sukses/gagal). Tidak ada efek samping jaringan di destruktor.
// ---------------------------------------------------------------------------
struct SyncResult {
  bool attempted = false;        // true bila runSyncOnce berjalan (ada link)
  // Push offline-log:
  bool uploadOk = false;         // true bila minimal satu batch berhasil di-POST
  size_t logsUploaded = 0;       // entri yang dikirim (akumulasi batch)
  size_t logsAcked = 0;          // entri ber-ACK & dihapus dari antrean (Req 6.3)
  // Pull whitelist:
  bool whitelistFetched = false; // true bila respons delta/penuh diterima
  bool deltaApplied = false;     // true bila applyDeltaVerified sukses (Req 4.3)
  bool usedFullFallback = false; // true bila jatuh ke full fetch (since_version=0)
  int64_t newDbVersion = -1;     // db_version setelah apply (-1 bila tak berubah)
};

// ---------------------------------------------------------------------------
// runSyncOnce — jalankan SATU siklus delta-sync (push logs → pull whitelist).
//
// Dipanggil oleh syncTask saat ctx.wifiConnected && ctx.syncRequested. URL
// dibentuk dari ctx.config (base URL + deviceId / whitelistUrl). Setiap request
// menyertakan ctx.config.apiKey (Req 7.3). Memakai `transport` yang diberikan
// (default transport ESP32 bila nullptr dan dibangun di firmware-target).
//
// Mengembalikan ringkasan SyncResult. TIDAK pernah melempar; kegagalan jaringan
// dilaporkan via field hasil (antrean tetap utuh untuk retry berikutnya).
// ---------------------------------------------------------------------------
SyncResult runSyncOnce(AppContext& ctx, HttpTransport* transport = nullptr);

// ---------------------------------------------------------------------------
// Pembentukan URL (diekspos untuk pengujian). Semua memakai base URL yang
// diturunkan dari ctx.config (lihat deriveBaseUrl) + deviceId.
//   offline-logs : <base>/api/devices/<dev>/offline-logs
//   whitelist    : <base>/api/devices/<dev>/whitelist?since_version=<N>
// ---------------------------------------------------------------------------

// Turunkan base URL (skema+host[:port], tanpa trailing slash) dari config.
// Mengutamakan ctx.config.whitelistUrl (mengambil bagian sebelum
// "/api/devices/..."); bila kosong, kembalikan string kosong (pemanggil
// memperlakukan sebagai "tak terkonfigurasi" dan melewati sync REST).
std::string deriveBaseUrl(const AppConfig& config);

// Bentuk URL endpoint offline-logs untuk device.
std::string buildOfflineLogsUrl(const std::string& baseUrl,
                                const std::string& deviceId);

// Bentuk URL endpoint whitelist delta dengan since_version.
std::string buildWhitelistUrl(const std::string& baseUrl,
                              const std::string& deviceId,
                              int64_t sinceVersion);

}  // namespace app
}  // namespace smartdoor

#endif  // SMARTDOOR_SYNC_CLIENT_H
