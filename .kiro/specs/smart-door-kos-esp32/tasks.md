# Implementation Plan

*Rencana Implementasi: Smart Door KOS ESP32*

## Overview

Rencana ini memecah desain menjadi langkah-langkah pengkodean inkremental untuk dua target. **TARGET 2 — Web Server Node.js** dikerjakan lebih dulu karena merupakan target yang dapat dibangun dan diuji di workspace ini (Express + better-sqlite3 + mqtt + SSE, CommonJS). Modul logika murni (derivasi kunci, keputusan akses, rekonstruksi delta-sync, idempotensi offline-log, klasifikasi online/offline, state machine brute-force/tamper, timeout door-ajar, penandaan sync_type) diprioritaskan agar dapat diuji dengan property-based testing sesuai 17 Correctness Properties di desain.

Setelah server, **TARGET 1 — Firmware ESP32 (C++/Arduino)** dikerjakan sebagai scaffolding + lapisan logika portabel (dapat diuji di host) ditambah tugas integrasi perangkat keras yang ditandai opsional/hardware-gated karena tidak dapat diverifikasi di workspace ini (NFC reader PN532/RC522, RTC DS3231, relay, reed switch).

Konvensi: tugas dengan postfix `*` bersifat opsional (test atau hardware-gated) dan tidak diimplementasikan otomatis oleh coding agent. Setiap property test menandai: **Feature: smart-door-kos-esp32, Property {n}: {teks}**.

---

## Tasks

### TARGET 2 — Web Server & Dashboard (Node.js) — Fondasi

- [x] 1. Siapkan struktur proyek, tooling, dan dependensi server
  - Buat struktur direktori `src/` (`db/`, `middleware/`, `routes/`, `services/`, `public/`) sesuai desain
  - Tambahkan dependensi runtime (`express`, `better-sqlite3`) ke `package.json`; `mqtt` sudah ada
  - Tambahkan framework uji dan PBT: `vitest` + `fast-check` (devDependencies); set script `"test": "vitest --run"`
  - Buat file konstanta/util bersama (mis. `src/constants.js`) untuk status kartu, nilai `sync_type`, dan nama topik MQTT
  - _Requirements: 7.1, 7.2, 19.1_

- [x] 2. Siapkan skema basis data dan lapisan koneksi
  - [x] 2.1 Tulis `src/db/schema.sql` dengan tabel `users`, `rooms`, `cards`, `devices`, `access_logs`
    - `cards`: `uid` PK, `user_id` FK, `room_id` FK, `key_version`, `status`, `expired_at`, `db_version`, `card_hash`, `UNIQUE(uid)`
    - `access_logs`: `idempotency_key` UNIQUE, `device_id`, `uid`, `result`, `ts`, `sync_type`
    - `devices`: `device_id` PK, `room_id`, `last_seen`, `rssi`, `fs_free`, `db_version`, `lock_open_duration_s`, `door_ajar_timeout_s`
    - _Requirements: 19.1, 8.3, 9.1, 11.3, 15.1, 17.1, 17.2, 19.3_
  - [x] 2.2 Implementasikan `src/db/index.js` (koneksi better-sqlite3 + jalankan migrasi dari `schema.sql`)
    - Ekspos instance DB tunggal dan helper transaksi
    - _Requirements: 19.1_
  - [x]* 2.3 Tulis unit test constraint skema
    - Uji `UNIQUE(uid)` menolak kartu ganda dan `UNIQUE(idempotency_key)` pada `access_logs`
    - _Requirements: 8.3, 19.3_

### TARGET 2 — Modul Logika Murni (prioritas property-test)

- [x] 3. Implementasikan derivasi Diversified_Key
  - [x] 3.1 Tulis `src/services/keyDerivation.js`
    - `derive(masterKey, uid) -> { diversifiedKey, keyVersion }` memakai CMAC-AES128(Master_Key, UID || label) sesuai desain
    - Master_Key dibaca dari env/config, tidak di-hardcode
    - _Requirements: 1.4, 2.2_
  - [x]* 3.2 Tulis property test determinisme derivasi kunci
    - **Property 3: Determinisme derivasi diversified key** (UID sama → kunci sama; UID berbeda → kunci berbeda)
    - **Validates: Requirements 1.4, 2.2**

- [x] 4. Implementasikan verifikasi kripto challenge-response (lapisan logika murni bersama)
  - [x] 4.1 Tulis `src/services/cryptoVerify.js`
    - `respond(nonce, diversifiedKey)` = AES-128 atas nonce; `verify(nonce, response, diversifiedKey)` menerima iff cocok
    - Modul ini juga menjadi referensi portabel untuk lapisan keputusan firmware
    - _Requirements: 1.1, 1.3, 1.5_
  - [x]* 4.2 Tulis property test verifikasi kripto
    - **Property 1: Verifikasi hanya menerima bukti kripto yang benar** (response salah/kloning UID → DENY)
    - **Validates: Requirements 1.1, 1.5**
  - [x]* 4.3 Tulis property test round-trip AES-128
    - **Property 2: Round-trip challenge-response AES-128** (decrypt(encrypt(nonce)) == nonce dan verifikasi menerima)
    - **Validates: Requirements 1.3**

- [x] 5. Implementasikan logika keputusan akses dari whitelist (murni, portabel ke firmware)
  - [x] 5.1 Tulis `src/services/accessDecision.js`
    - `decide(card, now)` → GRANT iff kripto valid DAN status bukan SUSPENDED/REVOKED DAN `now < expired_at`; selain itu DENY
    - `effectiveStatus(card, now)` → SUSPENDED iff `now >= expired_at`
    - _Requirements: 3.4, 4.2, 9.2, 9.3_
  - [x]* 5.2 Tulis property test keputusan akses lokal
    - **Property 4: Keputusan akses dari whitelist lokal** (GRANT tepat saat tidak Suspended & belum kedaluwarsa, bahkan offline)
    - **Validates: Requirements 3.4, 4.2, 9.3**
  - [x]* 5.3 Tulis property test status kedaluwarsa
    - **Property 5: Status kedaluwarsa menolak akses** (Suspended iff `now >= expired_at`; Suspended → DENY)
    - **Validates: Requirements 9.2, 9.3**

- [x] 6. Implementasikan versioning whitelist, hash, dan rekonstruksi delta-sync
  - [x] 6.1 Tulis `src/services/whitelistVersion.js`
    - Hitung `card_hash` (SHA-256 isi relevan) dan `db_hash` (SHA-256 daftar card_hash terurut); naikkan `db_version` saat kartu berubah
    - `computeDelta(sinceVersion, serverCards) -> { changed, removed, db_version, db_hash }`
    - `applyDelta(localSnapshot, delta) -> newSnapshot` (digunakan juga sebagai referensi firmware)
    - _Requirements: 4.3_
  - [x]* 6.2 Tulis property test rekonstruksi delta-sync
    - **Property 7: Delta sync merekonstruksi state server** (apply(changed+removed) → db_hash identik dengan snapshot server)
    - **Validates: Requirements 4.3**
  - [x]* 6.3 Tulis property test pencabutan tepat sasaran (pada lapisan whitelist)
    - **Property 6: Pencabutan menghapus akses tepat sasaran** (hapus satu UID → DENY untuk UID itu; UID lain tak berubah)
    - **Validates: Requirements 10.2, 10.3**

- [x] 7. Implementasikan serialisasi & idempotensi offline-log
  - [x] 7.1 Tulis `src/services/offlineLog.js`
    - `serialize(event) -> baris JSONL` dan `parse(line) -> event` (round-trip setara)
    - `pruneAcked(queue, ackedIds) -> queue'` (buang tepat entri ber-ACK)
    - `dedupeByKey(logs) -> uniqueLogs` berdasarkan `idempotency_key`
    - _Requirements: 5.1, 6.2, 6.3, 6.4, 19.2, 19.3_
  - [x]* 7.2 Tulis property test round-trip serialisasi log
    - **Property 8: Round-trip serialisasi log offline** (serialize→parse setara; panjang antrean +1)
    - **Validates: Requirements 5.1**
  - [x]* 7.3 Tulis property test pengosongan antrean ber-ACK
    - **Property 9: Pengosongan antrean hanya untuk entri ber-ACK** (hasil = antrean awal − id ber-ACK)
    - **Validates: Requirements 6.2, 6.3**

- [x] 8. Implementasikan klasifikasi kesehatan perangkat dan state machine keamanan (murni)
  - [x] 8.1 Tulis `src/services/deviceHealth.js` (logika klasifikasi)
    - `isOffline(lastSeen, now, interval) -> boolean` (Offline iff `now - lastSeen > interval`)
    - _Requirements: 11.2, 11.4_
  - [x]* 8.2 Tulis property test klasifikasi online/offline
    - **Property 12: Klasifikasi status online/offline perangkat** (Offline iff `now - last_seen > interval`)
    - **Validates: Requirements 11.2, 11.4**
  - [x] 8.3 Tulis `src/services/securityState.js` (state machine brute-force & tamper, logika portabel)
    - `bruteForce.onTap(state, isKnown)` → picu event tepat saat >3 tap tak dikenal berturut-turut; tap dikenal reset counter
    - `tamper.onDoorTransition(state, doorOpen, relayEngaged)` → picu event iff pintu terbuka tanpa relay diaktifkan
    - `doorAjar.isAlarm(openDurationMs, timeoutMs) -> boolean` (alarm iff durasi > timeout)
    - _Requirements: 13.1, 13.2, 17.4_
  - [x]* 8.4 Tulis property test deteksi brute-force
    - **Property 13: Pemicu deteksi brute-force** (picu tepat >3 tap tak dikenal berturut-turut; tap dikenal reset)
    - **Validates: Requirements 13.1**
  - [x]* 8.5 Tulis property test deteksi tamper
    - **Property 14: Pemicu deteksi tamper** (tamper iff pintu terbuka tanpa relay aktif)
    - **Validates: Requirements 13.2**
  - [x]* 8.6 Tulis property test alarm door-ajar
    - **Property 17: Alarm door-ajar sesuai timeout** (alarm iff durasi terbuka > Door_Ajar_Timeout)
    - **Validates: Requirements 17.4**

- [x] 9. Checkpoint — Pastikan semua test logika murni lulus
  - Ensure all tests pass, ask the user if questions arise.

### TARGET 2 — Transport, API, dan Layanan

- [x] 10. Implementasikan middleware autentikasi API_Key
  - [x] 10.1 Tulis `src/middleware/apiKey.js`
    - Validasi header `X-API-Key` (atau field `api_key` payload); `401` bila absen/salah
    - Ekspos helper `isValidApiKey(provided)` untuk dipakai ulang konsumer MQTT
    - _Requirements: 7.3, 7.4_
  - [x]* 10.2 Tulis property test autentikasi API_Key
    - **Property 11: Autentikasi menerima iff API_Key valid** (diproses iff API_Key valid; selain itu ditolak)
    - **Validates: Requirements 7.3, 7.4**

- [x] 11. Implementasikan audit trail dan penandaan sync_type
  - [x] 11.1 Tulis `src/services/auditTrail.js`
    - `recordLog(log, source)` menyimpan ke `access_logs` dengan `sync_type` = `REALTIME` (jalur live online) atau `CACHED_OFFLINE` (dari antrean offline), idempoten via `INSERT ... ON CONFLICT(idempotency_key) DO NOTHING`
    - Kembalikan daftar `accepted_ids`
    - _Requirements: 15.1, 15.2, 15.3, 6.4, 19.2, 19.3_
  - [x]* 11.2 Tulis property test penandaan sync_type
    - **Property 15: Penandaan Sync_Type sesuai sumber** (REALTIME iff jalur live online; CACHED_OFFLINE iff dari antrean offline)
    - **Validates: Requirements 15.2, 15.3**
  - [x]* 11.3 Tulis property test idempotensi ingest
    - **Property 10: Ingest log bersifat idempoten** (baris tersimpan = jumlah key unik; ingest ganda tak menambah baris)
    - **Validates: Requirements 6.4, 19.2, 19.3**

- [x] 12. Implementasikan MQTT service (topik, konsumer, publisher perintah)
  - Tulis `src/services/mqttService.js`: koneksi broker, subscribe heartbeat/log/event, publish cmd unlock/revoke/suspend/config
  - Validasi `api_key` pada tiap payload sebelum diproses; abaikan perintah tanpa API_Key valid
  - Konsumer heartbeat memperbarui `last_seen/rssi/fs_free/db_version` di `devices`; konsumer log memanggil `auditTrail.recordLog(..., REALTIME)`; konsumer event tamper/bruteforce menandai alert
  - _Requirements: 7.1, 7.3, 7.4, 9.2, 10.1, 11.1, 12.2, 13.1, 13.2, 13.3, 14.1, 15.2, 17.3_

- [x] 13. Implementasikan live feed SSE hub
  - Tulis `src/services/liveFeed.js`: endpoint `GET /api/feed` (`text/event-stream`) + broadcast event akses/alert ke klien dashboard
  - Dengan opsi WebSocket; hubungkan ke auditTrail & konsumer MQTT agar setiap log/alert ter-broadcast real-time
  - _Requirements: 14.1, 13.3_

- [x] 14. Implementasikan billing-lock scheduler dan pencabutan instan
  - [x] 14.1 Tulis `src/services/billingScheduler.js`
    - Job periodik: pindai `cards` `expired_at <= now AND status != 'SUSPENDED'`, set `status='SUSPENDED'`, naikkan `db_version`, publish `cmd/suspend` via MQTT, tandai whitelist untuk delta
    - _Requirements: 9.1, 9.2, 9.3_
  - [x] 14.2 Tulis `src/routes/revoke.js`
    - `POST /api/cards/:uid/revoke` → set `status='REVOKED'`, naikkan `db_version`, publish `cmd/revoke` via MQTT
    - _Requirements: 10.1_

- [x] 15. Implementasikan endpoint CRUD entitas dan provisioning
  - [x] 15.1 Tulis `src/routes/residents.js`, `src/routes/rooms.js`, `src/routes/cards.js`
    - CRUD penuh; saat registrasi resident, ikat satu kartu ke satu resident dan satu room (`UNIQUE(uid)`)
    - _Requirements: 8.1, 8.2, 8.3_
  - [x] 15.2 Tulis `src/routes/provisioning.js`
    - `POST /api/provisioning` → panggil `keyDerivation.derive`, tulis diversified key ke kartu, insert `status='ACTIVE'` + `expired_at`; bila gagal tandai `UNPROVISIONED` dan kembalikan error
    - _Requirements: 2.1, 2.2, 2.3, 9.1_
  - [x]* 15.3 Tulis unit test binding & provisioning
    - Uji binding kartu↔resident↔room dan jalur gagal provisioning (`UNPROVISIONED` + kode error)
    - _Requirements: 8.3, 2.3_

- [x] 16. Implementasikan endpoint whitelist (penuh + delta) dan ingest offline-log
  - [x] 16.1 Tulis `src/routes/whitelist.js`
    - `GET /api/devices/:dev/whitelist` (penuh) dan `?since_version=N` (delta via `whitelistVersion.computeDelta`), sertakan `db_version`/`db_hash`
    - _Requirements: 4.1, 4.3, 7.2_
  - [x] 16.2 Tulis `src/routes/offlineLogs.js`
    - `POST /api/devices/:dev/offline-logs` → `auditTrail.recordLog(..., CACHED_OFFLINE)` idempoten, kembalikan `accepted_ids`
    - _Requirements: 6.4, 15.3, 19.2, 19.3_

- [x] 17. Implementasikan endpoint device health, remote unlock, OTA, dan config pintu
  - [x] 17.1 Tulis `src/routes/devices.js` (health + unlock)
    - `GET` status device (Online/Offline via `deviceHealth.isOffline`, RSSI, fs_free, db_version); `POST /api/devices/:dev/unlock` → publish `cmd/unlock` + nonce via MQTT
    - _Requirements: 11.2, 11.3, 11.4, 12.1, 12.2_
  - [x] 17.2 Tulis `src/routes/ota.js`
    - `POST /api/devices/:dev/ota` → simpan `.bin` + checksum SHA-256, tolak berkas korup, jadwalkan delivery OTA (push URL+API_Key via MQTT)
    - Ekspos helper murni `verifyBinary(bytes, expectedChecksum) -> boolean` (referensi portabel untuk verifikasi firmware) agar keputusan apply/tolak dapat diuji
    - _Requirements: 16.1, 16.2, 16.3_
  - [x]* 17.2.1 Tulis property test verifikasi OTA
    - **Property 16: OTA invalid tidak mengubah firmware berjalan** (apply iff checksum/validitas lolos; berkas korup → tolak, versi berjalan tetap)
    - **Validates: Requirements 16.3**
  - [x] 17.3 Tulis `src/routes/config.js`
    - `PUT /api/devices/:dev/config` → simpan `lock_open_duration_s`/`door_ajar_timeout_s`, publish `cmd/config` via MQTT
    - _Requirements: 17.1, 17.2, 17.3_

- [x] 18. Wiring server: bootstrap aplikasi
  - Tulis `src/app.js`: inisialisasi Express + semua route (dengan `apiKey` middleware), DB/migrasi, `mqttService`, `billingScheduler`, dan `liveFeed` hub
  - Sajikan dashboard statis dari `public/`; pastikan setiap route REST diproteksi API_Key
  - _Requirements: 7.2, 7.3, 7.4, 8.1, 8.2, 9.2, 10.1, 11.1, 12.2, 14.1, 16.2, 17.3_

- [x]* 19. Tulis integration test alur server end-to-end
  - Remote unlock via MQTT (mock broker), live feed SSE menerima event, ingest offline-log idempoten lintas dua pengiriman
  - _Requirements: 12.2, 12.3, 14.1, 6.4_

- [x] 20. Checkpoint — Pastikan seluruh test & build server lulus
  - Ensure all tests pass, ask the user if questions arise.

### TARGET 1 — Firmware ESP32 (C++/Arduino)

- [-] 21. Scaffolding proyek firmware
  - Buat struktur PlatformIO/Arduino `firmware/` (`src/`, `lib/`, `test/`, `platformio.ini`) dengan dependensi ArduinoJson, PubSubClient/MQTT, RTClib, LittleFS, driver NFC (PN532/RC522)
  - Definisikan tata letak LittleFS: `whitelist.json`, `offline_logs.jsonl`, `config.json`, `device.key`
  - _Requirements: 4.1, 5.1, 18.1_

- [x] 22. Implementasikan lapisan logika keputusan portabel (dapat diuji di host)
  - [x] 22.1 Tulis modul keputusan akses C++ portabel (`firmware/lib/decision/`)
    - Port logika `accessDecision` & `cryptoVerify` ke C++ murni (tanpa dependensi hardware) agar dapat diuji di host
    - _Requirements: 1.1, 1.5, 3.4, 4.2, 9.3_
  - [x] 22.2 Tulis modul whitelist/delta & offline-log C++ portabel
    - `applyDelta` + verifikasi `db_hash`; serialisasi/parse JSONL + prune ber-ACK + counter idempotency persisten
    - _Requirements: 4.3, 5.1, 6.3, 6.4_
  - [x] 22.3 Tulis modul state machine keamanan C++ portabel
    - Brute-force (>3 tap tak dikenal), tamper (open tanpa relay), door-ajar (durasi > timeout)
    - _Requirements: 13.1, 13.2, 17.4_
  - [x]* 22.4 Tulis property/unit test host untuk lapisan logika firmware
    - Verifikasi paritas dengan Property 4, 6, 7, 8, 9, 13, 14, 17 menggunakan framework uji host (mis. Unity/doctest + generator)
    - **Validates: Requirements 3.4, 4.3, 6.3, 13.1, 13.2, 17.4**

- [x] 23. Implementasikan model penjadwalan non-blocking dan watchdog
  - Tulis kerangka FreeRTOS task (`nfcReadTask`, `doorControlTask`, `wifiTask`, `mqttTask`, `syncTask`, `timeTask`) tanpa `delay()` di jalur kritis; `millis()`-based
  - Konfigurasi Task Watchdog Timer (TWDT) + `esp_task_wdt_reset()` di tiap task; alokasi ArduinoJson terukur (`StaticJsonDocument` berbatas)
  - Rekoneksi WiFi non-blocking (state machine + backoff) yang tidak memblok verifikasi lokal
  - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5_

- [x] 24. Integrasikan penyimpanan LittleFS dan strategi waktu RTC
  - Implementasikan baca/tulis `whitelist.json`/`offline_logs.jsonl`/`config.json` + simpan diversified key terenkripsi (`device.key`/NVS)
  - Integrasikan RTC DS3231 untuk timestamp ISO-8601 UTC; sinkron RTC↔NTP saat online; timestamp akurat setelah power loss
  - _Requirements: 4.1, 4.2, 5.1, 5.2, 5.3, 5.4_

- [ ]* 25. Integrasikan NFC reader dan verifikasi kripto (HARDWARE — perlu PN532/RC522 + kartu DESFire/NTAG)
  - Baca UID, lakukan AES-128 challenge-response / encrypted file read dengan diversified key; DENY bila gagal, relay diam
  - Pastikan latensi verifikasi lokal < 200 ms; wiring hasil ke relay & enqueue log
  - _Requirements: 1.1, 1.2, 1.3, 1.5, 3.1, 3.2, 3.3, 3.4_

- [ ]* 26. Integrasikan relay, reed switch, dan alarm door-ajar (HARDWARE — perlu relay + reed switch)
  - Gerakkan relay saat GRANT/remote unlock; timer `Lock_Open_Duration`; deteksi door-ajar via reed switch → alarm; deteksi tamper (open tanpa relay)
  - _Requirements: 3.4, 12.3, 13.2, 17.4_

- [x] 27. Implementasikan networking firmware: MQTT dan sinkronisasi REST
  - [x] 27.1 Implementasikan klien MQTT firmware
    - Publish heartbeat (`rssi/fs_free/db_version`), live log (`REALTIME`), event tamper/bruteforce; subscribe `cmd/unlock|revoke|suspend|config`; sertakan & validasi `api_key` di tiap payload
    - _Requirements: 7.1, 7.3, 7.4, 9.2, 9.3, 10.1, 10.2, 10.3, 11.1, 12.2, 12.3, 13.1, 13.2, 14.1, 17.3_
  - [x] 27.2 Implementasikan `syncTask` REST delta-sync & ingest
    - Saat WiFi pulih: `POST offline-logs` (batch + idempotency ids) → hapus entri ber-ACK; `GET whitelist?since_version=N` → terapkan delta + verifikasi `db_hash`; API_Key di tiap request
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 4.3, 7.2, 7.3_

- [ ]* 28. Implementasikan penerimaan OTA firmware (HARDWARE/INTEGRASI — perlu perangkat ESP32)
  - Tarik `.bin` via HTTP REST dengan API_Key, verifikasi checksum/validitas; bila gagal batalkan dan tetap jalankan firmware lama
  - _Requirements: 16.2, 16.3_

- [x] 29. Wiring firmware: integrasi `main.cpp`
  - Satukan semua task, modul logika portabel, LittleFS, RTC, MQTT, dan syncTask di entry point; muat `config.json`; jalankan loop non-blocking
  - _Requirements: 3.1, 3.3, 4.2, 5.2, 7.1, 18.1, 18.2_

- [x] 30. Checkpoint akhir — Pastikan test host firmware & build server lulus
  - Ensure all tests pass, ask the user if questions arise.

---

## Notes

- Tugas dengan `*` bersifat opsional: mencakup test (unit/property/integration) dan tugas yang bergantung perangkat keras (NFC reader, DS3231, relay, reed switch, OTA pada perangkat fisik) yang tidak dapat diverifikasi di workspace ini.
- TARGET 2 (Node.js) adalah target utama yang dapat dibangun & diuji di workspace; dikerjakan lebih dulu, dengan modul logika murni diprioritaskan untuk property-based testing.
- TARGET 1 (firmware) memisahkan lapisan logika portabel (dapat diuji di host) dari integrasi hardware (hardware-gated).
- 17 Correctness Properties dipetakan ke sub-tugas test spesifik; setiap test menandai nomor Property dan klausa Requirements yang divalidasi.
- Checkpoint memastikan validasi inkremental sebelum melanjutkan.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["2.1"] },
    { "id": 1, "tasks": ["2.2", "2.3", "3.1", "4.1", "5.1", "7.1", "8.1", "8.3"] },
    { "id": 2, "tasks": ["3.2", "4.2", "4.3", "5.2", "5.3", "6.1", "7.2", "7.3", "8.2", "8.4", "8.5", "8.6", "10.1"] },
    { "id": 3, "tasks": ["6.2", "6.3", "10.2", "11.1"] },
    { "id": 4, "tasks": ["11.2", "11.3", "12", "14.1", "14.2", "15.1", "16.1"] },
    { "id": 5, "tasks": ["13", "15.2", "16.2", "17.1", "17.2", "17.2.1", "17.3"] },
    { "id": 6, "tasks": ["15.3", "18"] },
    { "id": 7, "tasks": ["19"] },
    { "id": 8, "tasks": ["22.1", "22.2", "22.3"] },
    { "id": 9, "tasks": ["22.4", "23", "24"] },
    { "id": 10, "tasks": ["25", "26", "27.1", "27.2"] },
    { "id": 11, "tasks": ["28", "29"] }
  ]
}
```
