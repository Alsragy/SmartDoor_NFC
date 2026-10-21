# Smart Door KOS — Firmware ESP32 (TARGET 1)

Firmware *offline-first* untuk pengambil keputusan akses di edge: membaca kartu
NFC kripto, memverifikasi secara kriptografis (<200 ms), menggerakkan relay,
mencatat log, dan menyinkronkan data ke Web_Server secara **non-blocking**
(design.md — "TARGET 1 — Desain Firmware ESP32").

> **Status: WIRING PENUH (Task 29).** Entry point `main.cpp` kini merakit
> seluruh firmware: memuat `config.json` (termasuk kredensial WiFi), memasang
> hook LittleFS + RTC (Task 24), menginstansiasi klien MQTT di `mqttTask`
> (Task 27.1), menjalankan `runSyncOnce` di `syncTask` (Task 27.2), dan
> menjadwalkan enam FreeRTOS task non-blocking di bawah watchdog (Task 23).
> Modul logika portabel (Task 22) host-teruji. **Belum dikompilasi** di
> workspace ini (tidak ada toolchain/hardware ESP32).
>
> **Tersisa untuk perangkat nyata:** driver **NFC** (`nfcPoll`, Task 25) dan
> **relay/reed/alarm** (`relaySet`/`doorIsOpen`/`alarmSet`, Task 26). Hook ini
> sengaja dibiarkan `nullptr` di `main.cpp`; kerangka task memperlakukan hook
> null secara aman (nfcPoll null → idle, door null → tertutup, relay/alarm null
> → no-op) sehingga firmware tetap berjalan sebelum hardware terpasang.

## Struktur

```
firmware/
├── platformio.ini     # env esp32dev (build/flash) + env native (test host)
├── src/                # lem firmware (Arduino-target), bukan modul host
│   ├── main.cpp         # entry point (Task 29): config+hook → TWDT → startTasks
│   ├── app_config.h     # shape config + SEAM hook (Task 23)
│   ├── tasks.h/.cpp     # kerangka 6 task FreeRTOS + watchdog (Task 23)
│   ├── storage.h/.cpp   # LittleFS: whitelist/logs/config + key seam (Task 24)
│   ├── rtc_time.h/.cpp  # RTC DS3231 + NTP, ISO-8601 UTC (Task 24)
│   ├── app_integration.h/.cpp  # wiring storage/RTC → hook task (Task 24)
│   ├── mqtt_client.h/.cpp  # klien MQTT: heartbeat/log/event + cmd/* (Task 27.1)
│   └── sync_client.h/.cpp  # REST delta-sync & ingest offline-log (Task 27.2)
├── lib/                # modul C++ portabel, teruji di host (Task 22.x)
│   └── README.md        #   decision/ · whitelist/ · security/
├── test/               # test host Unity (pio test -e native) (Task 22.4)
│   └── README.md
├── data/               # template LittleFS (di-flash via uploadfs)
│   ├── whitelist.json
│   ├── offline_logs.jsonl
│   ├── config.json
│   ├── device.key.sample
│   └── README.md
└── .gitignore
```

## Toolchain

Memerlukan [PlatformIO Core](https://platformio.org/) (`pio`). Perintah di
bawah dijalankan dari dalam direktori `firmware/`.

## Build & Flash (perangkat ESP32)

```bash
# Kompilasi firmware untuk ESP32
pio run

# Flash firmware ke perangkat
pio run -t upload

# Flash isi data/ ke partisi LittleFS (whitelist/config/logs/device.key)
pio run -t uploadfs

# Monitor serial
pio device monitor -b 115200
```

## Provisioning perangkat (sekali per perangkat)

Firmware memuat SEMUA rahasia dari LittleFS/NVS saat boot — tidak ada kredensial
yang di-hardcode di sumber. Langkah provisioning sekali untuk tiap perangkat:

1. **Siapkan `data/config.json`** dengan nilai perangkat sebenarnya (ganti
   placeholder `SAMPLE_*`):
   - `device_id` — id unik perangkat (prefiks idempotency key offline-log).
   - `wifi.ssid` + `wifi.password` — kredensial WiFi (dipakai `wifiTask` untuk
     `WiFi.begin`, rekoneksi non-blocking — Req 18.2).
   - `api_key` — API_Key ke Web_Server (disertakan di tiap payload MQTT/REST —
     Req 7.3).
   - `lock_open_duration_s` / `door_ajar_timeout_s` — timer pintu (Req 17).
   - `mqtt.host` / `mqtt.port` / `mqtt.base_topic` — broker MQTT (Req 7.1).
   - `whitelist_url` — endpoint unduh whitelist/delta (Req 4.3).
2. **Siapkan `data/whitelist.json`** snapshot awal (boleh kosong; `syncTask`
   akan menariknya saat online).
3. **Siapkan `data/device.key`** kunci enkripsi lokal diversified_key.
   **JANGAN** commit kunci nyata; `data/` hanya berisi `device.key.sample`.
   Produksi: simpan di **NVS terenkripsi / flash encryption ESP32**, bukan
   berkas datar (lihat [`data/README.md`](data/README.md)).
4. **Upload firmware lalu filesystem:**

   ```bash
   pio run -t upload     # flash firmware
   pio run -t uploadfs   # flash config.json / whitelist.json / device.key
   ```

5. **Verifikasi via monitor serial** bahwa LittleFS + RTC siap dan keenam task
   terjadwal.

> **Catatan hardware (Task 25/26):** driver **NFC** (`nfcPoll`) dan
> **relay/reed/alarm** belum terpasang. Hook terkait dibiarkan `nullptr` di
> `main.cpp` dan HARUS diinstal pada perangkat keras nyata (Task 25/26) agar
> pintu benar-benar membaca kartu & menggerakkan kunci. Tanpa hook ini firmware
> boot & non-blocking, tetapi `nfcReadTask` idle dan relay tidak beraksi.

## Test host (logika portabel)

Modul murni di `lib/` diuji di host tanpa hardware melalui environment
`native`:

```bash
pio test -e native
```

## Dependensi (platformio.ini → `lib_deps`)

| Pustaka                  | Guna                                   | Req     |
|--------------------------|----------------------------------------|---------|
| ArduinoJson              | parse/serialize whitelist & log (terukur) | 4.1, 5.1, 18.3 |
| PubSubClient             | klien MQTT (heartbeat, cmd, live log)  | 7.1     |
| RTClib                   | RTC DS3231 — timestamp ISO-8601 UTC     | 5.2     |
| Adafruit PN532 + BusIO   | driver NFC PN532 (default)             | 1, 3    |
| MFRC522 *(alternatif)*   | driver NFC RC522                       | 1, 3    |

Filesystem flash: **LittleFS** (`board_build.filesystem = littlefs`).

## Tata Letak LittleFS

Lihat [`data/README.md`](data/README.md) untuk shape tiap berkas
(`whitelist.json`, `offline_logs.jsonl`, `config.json`, `device.key`) dan
catatan keamanan `device.key` (produksi: gunakan NVS terenkripsi).

## Standar pengkodean non-blocking (Req 18)

- Tanpa `delay()` di jalur kritis; gunakan `millis()` / FreeRTOS task
  (`vTaskDelay` sebagai yield).
- Verifikasi kartu lokal tidak menunggu jaringan (Req 3.3); rekoneksi WiFi
  non-blocking (Req 18.2).
- Alokasi ArduinoJson terukur / `StaticJsonDocument` berbatas (Req 18.3).
- Task Watchdog Timer (TWDT) aktif di tiap task (Req 18.4).

## Hubungan dengan Web Server

Repo root adalah Web_Server Node.js (TARGET 2). Firmware berkomunikasi lewat
MQTT (perintah real-time) dan HTTP REST (unduh whitelist/delta, ingest
offline-log, OTA), menyertakan `api_key` di setiap payload/permintaan (Req 7).

### Pemisahan transport: MQTT (real-time) vs REST (rekonsiliasi)

Kedua jalur memakai API_Key, tetapi punya peran berbeda dan tidak boleh memblok
`nfcReadTask`:

| Aspek        | MQTT — `mqttTask` (Task 27.1)                           | REST — `syncTask` → `sync_client` (Task 27.2)                       |
|--------------|---------------------------------------------------------|---------------------------------------------------------------------|
| Pola         | Pub/Sub (push), latensi rendah                          | Request/Response (pull/push), idempoten                             |
| Kapan        | Selama perangkat **online**                             | Sekali tiap **pemulihan** WiFi (transisi `DISCONNECTED→CONNECTED`)  |
| Isi          | Heartbeat, live log (`REALTIME`), event tamper/bruteforce; menerima `cmd/unlock\|revoke\|suspend\|config` | Unggah antrean `offline_logs.jsonl` (batch) + tarik delta whitelist |
| Auth         | `api_key` di tiap payload                               | Header `X-API-Key` di tiap request (Req 7.3)                        |
| Pemicu       | periodik (`millis`)                                     | `ctx.syncRequested` di-set `wifiTask` saat link up (Req 6.1)        |

### Alur `sync_client` (Task 27.2 — Req 6/4.3)

`syncTask` memanggil `runSyncOnce(ctx)` saat `wifiConnected && syncRequested`.
Mengikuti design.md "Alur Delta Sync saat Pemulihan WiFi":

1. **Push offline logs** — `drainOfflineLogsForUpload()` → body berbatas
   `{ logs:[{id,ts,uid,result,sync_type,ts_unverified?}] }` →
   `POST /api/devices/:dev/offline-logs` (X-API-Key) → parse
   `{ accepted_ids:[...] }` → `confirmUploadedLogs(accepted_ids)` menghapus
   TEPAT entri ber-ACK (Req 6.2/6.3). Entri tak-ACK tetap di antrean; karena
   `id` adalah idempotency key, kirim ulang aman (Req 6.4).
2. **Pull whitelist delta** — `GET /api/devices/:dev/whitelist?since_version=N`
   (N = `db_version` lokal, X-API-Key) → `applyWhitelistDeltaJson()` menerapkan
   delta + memverifikasi `db_hash` (Req 4.3/7.2). Bila verifikasi `db_hash`
   gagal → fallback full fetch (`since_version=0`) lalu terapkan ulang.

Properti non-blocking: transport HTTP timeout-bounded
(`sync_limits::kHttpTimeoutMs`), body & respons JSON dibatasi
(`BoundedAllocator`, Req 18.3), dikirim per-batch (`kMaxLogsPerBatch`), dan
berjalan di task prioritas RENDAH terpisah dari jalur verifikasi NFC. HTTP
diabstraksikan di balik seam `HttpTransport` agar alur dapat diuji di host
tanpa jaringan; transport default ESP32 (`HTTPClient` + `WiFiClient`) aktif di
balik guard `SMARTDOOR_FIRMWARE_TARGET`.
