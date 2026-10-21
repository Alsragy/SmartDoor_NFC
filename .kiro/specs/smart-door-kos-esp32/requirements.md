# Requirements Document

## Introduction

Dokumen ini mendefinisikan kebutuhan untuk **Smart Door KOS ESP32**, sebuah sistem kontrol akses pintu berbasis NFC untuk lingkungan kos/hunian. Sistem terdiri dari dua target yang bekerja sama:

1. **Firmware ESP32 (C++/Arduino)** — pengambil keputusan lokal (edge) yang membaca kartu NFC kripto, memverifikasi akses secara offline-first, menggerakkan relay kunci, dan menyinkronkan data dengan server.
2. **Web Server & Dashboard (Node.js)** — pusat manajemen residen, provisioning kartu, pemantauan kesehatan perangkat, audit trail, dan pemeliharaan (OTA + konfigurasi).

Dokumen System Rules & Architecture Guidelines adalah **Single Source of Truth**. Setiap aturan diperlakukan sebagai requirement ketat dan non-negotiable.

### Asumsi (karena pertanyaan klarifikasi dilewati)

Asumsi berikut diambil berdasarkan konteks workspace dan default yang ditetapkan. Asumsi ini dapat ditinjau ulang:

- **Stack Web Server** menggunakan **Express** sebagai HTTP framework.
- **Basis data** menggunakan **SQLite melalui `better-sqlite3`** (akses sinkron, cocok untuk beban lokal).
- **Komunikasi MQTT** menggunakan dependency `mqtt` yang sudah ada di `package.json` (v5.x).
- **Live feed** dashboard menggunakan **SSE atau WebSocket**.
- Proyek Node.js menggunakan modul **CommonJS** (sesuai `package.json` eksisting: `"type": "commonjs"`).
- Pembaca NFC berbasis **PN532** atau **RC522**; kartu kripto berupa **Mifare DESFire EV2/EV3** atau **NTAG 424 DNA**.
- RTC eksternal menggunakan **DS3231**; penyimpanan lokal firmware menggunakan **LittleFS**.

## Glossary

- **System**: Keseluruhan sistem Smart Door KOS (firmware + web server) ketika requirement tidak spesifik ke satu target.
- **Firmware**: Perangkat lunak ESP32 yang berjalan di controller pintu.
- **Web_Server**: Aplikasi Node.js (Express) yang menyajikan API dan dashboard.
- **Dashboard**: Antarmuka web yang dikonsumsi administrator/pengelola kos.
- **NFC_Reader**: Modul pembaca kartu (PN532/RC522) yang terhubung ke Firmware.
- **Crypto_Card**: Kartu pintar kripto (Mifare DESFire EV2/EV3 atau NTAG 424 DNA) milik residen.
- **UID**: Nomor identitas unik kartu (tidak cukup sendirian untuk verifikasi).
- **Master_Key**: Kunci rahasia utama yang disimpan di Web_Server untuk menurunkan kunci per-kartu.
- **Diversified_Key**: Kunci per-kartu hasil derivasi dari Master_Key dan UID.
- **Provisioning_Endpoint**: Endpoint Web_Server untuk menyuntikkan kunci rahasia ke Crypto_Card baru.
- **Whitelist**: Daftar kartu valid beserta parameter kunci dekripsi yang disimpan di LittleFS.
- **LittleFS**: Sistem berkas flash lokal pada ESP32.
- **Offline_Log_Queue**: Berkas antrean log `/offline_logs.jsonl` di LittleFS saat koneksi terputus.
- **RTC**: Real Time Clock eksternal DS3231 pada ESP32.
- **NTP**: Network Time Protocol untuk sinkronisasi waktu saat online.
- **Delta_Sync**: Sinkronisasi hanya data kartu yang berubah berbasis versi/hash.
- **MQTT_Broker**: Broker pesan untuk perintah real-time (remote unlock, heartbeat, live log).
- **API_Key**: Token/kunci autentikasi yang disertakan pada setiap payload/header.
- **Resident**: Penghuni kos yang terikat pada satu kartu dan satu kamar.
- **Room**: Kamar kos yang dikelola di Web_Server.
- **Heartbeat**: Sinyal periodik dari Firmware yang menandakan perangkat hidup dan sehat.
- **Reed_Switch**: Sensor magnetik yang mendeteksi status pintu terbuka/tertutup.
- **Relay**: Aktuator yang membuka kunci pintu.
- **Watchdog_Timer**: Timer perangkat keras ESP32 yang me-restart controller bila program hang.
- **Sync_Type**: Penanda sumber log, bernilai `REALTIME` atau `CACHED_OFFLINE`.
- **OTA**: Over-The-Air firmware update melalui unggah berkas `.bin`.
- **Lock_Open_Duration**: Durasi (detik) kunci terbuka setelah verifikasi berhasil.
- **Door_Ajar_Timeout**: Batas waktu (detik) pintu boleh terbuka sebelum alarm door-ajar aktif.

## Requirements

### Requirement 1: Verifikasi Anti-Clone Berbasis Kartu Kripto (RULE A)

**User Story:** Sebagai pengelola kos, saya ingin verifikasi kartu menggunakan kriptografi dan bukan hanya UID, sehingga kartu tidak dapat dikloning dan akses tetap aman.

#### Acceptance Criteria

1. WHEN sebuah Crypto_Card ditempelkan ke NFC_Reader, THE Firmware SHALL melakukan verifikasi kriptografis dan tidak mengandalkan UID sebagai satu-satunya faktor verifikasi.
2. THE Firmware SHALL mendukung Crypto_Card tipe Mifare DESFire EV2/EV3 atau NTAG 424 DNA melalui NFC_Reader berbasis PN532 atau RC522.
3. WHEN memverifikasi sebuah Crypto_Card, THE Firmware SHALL menggunakan skema AES-128 Challenge-Response atau pembacaan berkas terenkripsi dengan diversified key.
4. THE Web_Server SHALL menurunkan Diversified_Key untuk setiap kartu dari Master_Key dan UID kartu tersebut.
5. IF verifikasi kriptografis gagal untuk sebuah Crypto_Card, THEN THE Firmware SHALL menolak akses dan tidak menggerakkan Relay.

### Requirement 2: Provisioning Kartu dari Web (RULE A)

**User Story:** Sebagai pengelola kos, saya ingin menyuntikkan kunci rahasia ke kartu baru saat registrasi residen, sehingga setiap kartu memiliki kredensial kripto yang unik.

#### Acceptance Criteria

1. THE Web_Server SHALL menyediakan Provisioning_Endpoint untuk menyuntikkan kunci rahasia ke sebuah Crypto_Card baru selama proses registrasi Resident.
2. WHEN Provisioning_Endpoint dipanggil untuk sebuah Crypto_Card, THE Web_Server SHALL menuliskan Diversified_Key yang diturunkan dari Master_Key dan UID ke kartu tersebut.
3. IF proses provisioning sebuah Crypto_Card gagal diselesaikan, THEN THE Web_Server SHALL mengembalikan kode kesalahan dan menandai kartu sebagai belum ter-provisioning.

### Requirement 3: Keputusan Lokal & Verifikasi Non-Blocking (RULE B)

**User Story:** Sebagai residen, saya ingin pintu merespons tap kartu seketika tanpa menunggu server, sehingga akses tetap cepat dan andal.

#### Acceptance Criteria

1. THE Firmware SHALL bertindak sebagai pengambil keputusan lokal untuk setiap verifikasi akses.
2. WHEN sebuah Crypto_Card ditempelkan, THE Firmware SHALL menyelesaikan verifikasi lokal dalam waktu kurang dari 200 milidetik.
3. WHEN sebuah Crypto_Card ditempelkan, THE Firmware SHALL memverifikasi menggunakan data lokal dan tidak melakukan permintaan blocking ke Web_Server.
4. WHERE sebuah Crypto_Card valid dan tidak Suspended, THE Firmware SHALL menggerakkan Relay untuk membuka kunci meskipun dalam kondisi offline.
5. THE Requirement ini SHALL hanya mengatur logika keputusan akses dan bukan jaminan aktuasi fisik Relay; kegagalan aktuasi Relay akibat kerusakan perangkat keras berada di luar lingkup Requirement ini.

### Requirement 4: Whitelist & Caching di Edge (RULE B)

**User Story:** Sebagai pengelola kos, saya ingin daftar kartu valid tersimpan di perangkat, sehingga pintu dapat memverifikasi akses tanpa koneksi server.

#### Acceptance Criteria

1. THE Firmware SHALL menyimpan Whitelist aktif beserta parameter kunci dekripsi di LittleFS.
2. WHEN memverifikasi sebuah Crypto_Card, THE Firmware SHALL membaca Whitelist dari LittleFS sebagai sumber keputusan akses.
3. WHERE Web_Server mengirim pembaruan kartu, THE Web_Server SHALL mengirim hanya data kartu yang berubah berbasis versi atau hash (Delta_Sync).

### Requirement 5: Antrean Log Offline & Timestamp Akurat (RULE B)

**User Story:** Sebagai pengelola kos, saya ingin semua kejadian akses tercatat dengan waktu akurat meski perangkat offline, sehingga audit trail tetap lengkap.

#### Acceptance Criteria

1. IF WiFi atau Web_Server tidak tersedia saat terjadi kejadian akses, THEN THE Firmware SHALL menuliskan log ke Offline_Log_Queue pada berkas `/offline_logs.jsonl` di LittleFS.
2. THE Firmware SHALL menggunakan RTC DS3231 untuk memberi timestamp pada setiap log.
3. WHILE perangkat online, THE Firmware SHALL menyinkronkan RTC dengan NTP.
4. IF terjadi kehilangan daya, THEN THE Firmware SHALL tetap menghasilkan timestamp akurat dari RTC setelah menyala kembali, selama RTC DS3231 masih valid (daya baterai cadangan tetap terjaga dan waktunya tidak ter-reset).
5. IF RTC DS3231 kehilangan daya baterai cadangan atau waktunya ter-reset, THEN THE Firmware SHALL mendeteksi kondisi tersebut dan menandai log yang terdampak sebagai memiliki timestamp tidak terverifikasi (unverified).

### Requirement 6: Sinkronisasi Delta saat Pemulihan WiFi (RULE B)

**User Story:** Sebagai pengelola kos, saya ingin log offline dan data kartu tersinkron otomatis saat WiFi pulih, sehingga tidak ada data yang hilang atau ganda.

#### Acceptance Criteria

1. WHEN WiFi pulih setelah terputus, THE Firmware SHALL memulai sinkronisasi delta secara otomatis.
2. WHEN sinkronisasi dimulai, THE Firmware SHALL mengirim isi Offline_Log_Queue ke Web_Server terlebih dahulu.
3. WHEN Web_Server mengembalikan ACK atas log yang diterima, THE Firmware SHALL mengosongkan entri Offline_Log_Queue yang telah di-ACK.
4. THE Web_Server SHALL menyediakan endpoint ingest log yang bersifat idempoten sebagai properti utama, dan tidak-terjadi-duplikasi ketika koneksi terputus di tengah sinkronisasi merupakan konsekuensi dari idempotensi tersebut.

### Requirement 7: Komunikasi Jaringan Lokal & Autentikasi (RULE C)

**User Story:** Sebagai pengelola kos, saya ingin komunikasi perangkat terautentikasi, sehingga residen pada WiFi yang sama tidak dapat menembus sistem.

#### Acceptance Criteria

1. THE Firmware SHALL menggunakan MQTT_Broker untuk perintah real-time berupa remote unlock, heartbeat, dan live log.
2. THE Web_Server SHALL menyediakan HTTP REST untuk unduhan Whitelist dan OTA.
3. THE System SHALL menyertakan API_Key pada setiap payload atau header komunikasi antara Firmware dan Web_Server.
4. IF sebuah payload atau permintaan tidak menyertakan API_Key yang valid, THEN THE penerima (Firmware atau Web_Server) SHALL menolak permintaan tersebut.

### Requirement 8: Manajemen Residen, Kamar & Kartu (WEB MODULE 1)

**User Story:** Sebagai pengelola kos, saya ingin mengelola residen, kamar, dan kartu, sehingga setiap akses terikat pada orang dan kamar yang jelas.

#### Acceptance Criteria

1. THE Web_Server SHALL menyediakan operasi create, read, update, dan delete untuk data Resident.
2. THE Web_Server SHALL menyediakan operasi create, read, update, dan delete untuk data Room.
3. WHEN seorang Resident didaftarkan, THE Web_Server SHALL mengikat satu Crypto_Card ke satu Resident dan satu Room.
4. IF sebuah Resident, Room, atau Crypto_Card sudah terikat sebelumnya, THEN THE Web_Server SHALL menolak binding baru tersebut sebagai penegakan ketat satu-ke-satu tanpa rebinding otomatis.

### Requirement 9: Penguncian Tagihan (Billing Lock) (WEB MODULE 1)

**User Story:** Sebagai pengelola kos, saya ingin akses kartu otomatis dinonaktifkan saat masa aktif habis, sehingga penagihan terhubung dengan hak akses.

#### Acceptance Criteria

1. THE Web_Server SHALL menyimpan atribut `expired_at` untuk setiap Crypto_Card.
2. WHEN `expired_at` sebuah Crypto_Card terlampaui, THE Web_Server SHALL melakukan sinkronisasi otomatis ke Firmware untuk menetapkan status kartu menjadi Suspended.
3. WHILE sebuah Crypto_Card berstatus Suspended, THE Firmware SHALL menolak akses untuk kartu tersebut.
4. IF sinkronisasi status Suspended ke Firmware gagal atau belum terjadi, THEN THE Crypto_Card SHALL tetap aktif secara fungsional di tingkat Firmware hingga sinkronisasi berhasil, dan THE Web_Server SHALL mencoba ulang sinkronisasi di kemudian waktu.

### Requirement 10: Pencabutan & Blacklist Seketika (WEB MODULE 1)

**User Story:** Sebagai pengelola kos, saya ingin mencabut akses kartu secara instan, sehingga kartu yang hilang atau disalahgunakan segera tidak berlaku.

#### Acceptance Criteria

1. WHEN pengelola memicu pencabutan akses untuk sebuah Crypto_Card, THE Web_Server SHALL mengirim perintah hapus-akses ke Firmware untuk menghapus kartu tersebut dari Whitelist di LittleFS.
2. WHEN Firmware menerima perintah hapus-akses, THE Firmware SHALL menghapus entri kartu dari Whitelist di LittleFS.
3. WHEN entri kartu telah dihapus dari Whitelist, THE Firmware SHALL menolak akses untuk kartu tersebut pada tap berikutnya.

### Requirement 11: Pemantauan Kesehatan Perangkat (WEB MODULE 2)

**User Story:** Sebagai pengelola kos, saya ingin memantau status tiap pintu, sehingga saya tahu perangkat mana yang bermasalah.

#### Acceptance Criteria

1. THE Firmware SHALL mengirim Heartbeat periodik melalui MQTT_Broker.
2. THE Dashboard SHALL menampilkan status Online atau Offline untuk setiap pintu berdasarkan Heartbeat.
3. THE Dashboard SHALL menampilkan nilai RSSI WiFi, ruang kosong LittleFS, dan versi basis data lokal aktif untuk setiap pintu.
4. IF Web_Server tidak menerima Heartbeat dari sebuah pintu dalam interval yang dikonfigurasi, THEN THE Dashboard SHALL menandai pintu tersebut sebagai Offline.

### Requirement 12: Remote Unlock (WEB MODULE 2)

**User Story:** Sebagai pengelola kos, saya ingin membuka pintu dari dashboard, sehingga saya dapat memberi akses jarak jauh saat diperlukan.

#### Acceptance Criteria

1. THE Dashboard SHALL menyediakan tombol remote unlock untuk setiap pintu.
2. WHEN tombol remote unlock ditekan, THE Web_Server SHALL mengirim perintah unlock ke Firmware melalui MQTT_Broker dengan API_Key yang valid.
3. WHEN Firmware menerima perintah remote unlock yang terautentikasi, THE Firmware SHALL menggerakkan Relay untuk membuka kunci.
4. WHERE perintah remote unlock dijalankan, THE System SHALL tidak diwajibkan melaporkan status kegagalan aktuasi Relay kembali ke Dashboard.

### Requirement 13: Deteksi Tamper & Brute-Force (WEB MODULE 2)

**User Story:** Sebagai pengelola kos, saya ingin peringatan saat ada upaya pembobolan, sehingga saya dapat merespons ancaman keamanan.

#### Acceptance Criteria

1. WHEN sebuah kartu tidak dikenal ditempelkan lebih dari 3 kali berturut-turut, THE Firmware SHALL mengirim kejadian deteksi brute-force ke Web_Server.
2. IF Reed_Switch mendeteksi pintu terbuka paksa tanpa adanya instruksi Relay, THEN THE Firmware SHALL mengirim kejadian deteksi tamper ke Web_Server.
3. WHEN Web_Server menerima kejadian tamper atau brute-force, THE Dashboard SHALL menampilkan alert merah untuk pintu terkait.

### Requirement 14: Live Access Feed (WEB MODULE 3)

**User Story:** Sebagai pengelola kos, saya ingin melihat aktivitas akses secara real-time, sehingga saya dapat memantau pintu secara langsung.

#### Acceptance Criteria

1. WHEN sebuah kejadian akses diterima Web_Server, THE Dashboard SHALL menampilkan kejadian tersebut pada live access feed secara real-time melalui WebSocket atau SSE.
2. IF koneksi WebSocket atau SSE terputus saat sebuah kejadian akses diterima, THEN THE kejadian tersebut SHALL dianggap hilang dari live access feed dan tidak ditampilkan ulang secara retroaktif saat koneksi pulih; ketentuan ini hanya mengatur live access feed dan tidak memengaruhi persistensi audit trail pada tabel `access_logs`.

### Requirement 15: Penandaan Sumber Log (WEB MODULE 3)

**User Story:** Sebagai pengelola kos, saya ingin membedakan log real-time dan log offline, sehingga audit trail dapat ditelusuri sumbernya.

#### Acceptance Criteria

1. THE Web_Server SHALL menyimpan atribut Sync_Type pada setiap log akses.
2. WHEN sebuah log diterima secara langsung saat perangkat online, THE Web_Server SHALL menetapkan Sync_Type log tersebut menjadi `REALTIME`.
3. WHEN sebuah log diterima dari Offline_Log_Queue saat sinkronisasi, THE Web_Server SHALL menetapkan Sync_Type log tersebut menjadi `CACHED_OFFLINE`.

### Requirement 16: Web OTA Update (WEB MODULE 4)

**User Story:** Sebagai pengelola kos, saya ingin memperbarui firmware dari web, sehingga perangkat dapat dipelihara tanpa akses fisik.

#### Acceptance Criteria

1. THE Dashboard SHALL menyediakan fitur unggah berkas firmware `.bin` untuk OTA.
2. WHEN berkas `.bin` diunggah untuk sebuah pintu, THE Web_Server SHALL mengirim firmware tersebut ke Firmware melalui HTTP REST over WiFi.
3. IF berkas OTA yang diterima tidak valid atau gagal verifikasi, THEN THE Firmware SHALL membatalkan pembaruan dan tetap menjalankan firmware yang ada.
4. WHILE firmware baru yang valid sedang di-swap atau diterapkan, THE kunci pintu MAY berada dalam kondisi tidak beroperasi sesaat hingga firmware baru siap mengambil alih.

### Requirement 17: Konfigurasi Parameter Pintu (WEB MODULE 4)

**User Story:** Sebagai pengelola kos, saya ingin mengatur parameter pintu dari dashboard, sehingga perilaku kunci dan alarm sesuai kebutuhan.

#### Acceptance Criteria

1. THE Dashboard SHALL menyediakan konfigurasi Lock_Open_Duration dalam satuan detik untuk setiap pintu.
2. THE Dashboard SHALL menyediakan konfigurasi Door_Ajar_Timeout dalam satuan detik untuk setiap pintu.
3. WHEN konfigurasi parameter pintu disimpan, THE Web_Server SHALL mengirim nilai konfigurasi ke Firmware terkait.
4. WHILE pintu terbuka melebihi Door_Ajar_Timeout, THE Firmware SHALL mengaktifkan alarm door-ajar.

### Requirement 18: Standar Pengkodean Firmware Non-Blocking (CODING STANDARDS / NFR)

**User Story:** Sebagai pengembang, saya ingin firmware berjalan non-blocking dan tahan hang, sehingga pintu tetap responsif dan residen tidak terkunci di luar.

#### Acceptance Criteria

1. THE Firmware SHALL menjalankan loop utama tanpa pemanggilan `delay()`, menggunakan `millis()` atau task FreeRTOS untuk penjadwalan.
2. WHILE koneksi WiFi terputus, THE Firmware SHALL melakukan rekoneksi secara non-blocking tanpa menghentikan verifikasi kartu lokal.
3. THE Firmware SHALL melakukan alokasi memori ArduinoJson secara aman untuk mencegah kegagalan alokasi.
4. THE Firmware SHALL menjaga Watchdog_Timer tetap aktif agar kondisi hang memicu restart otomatis.
5. IF Firmware mengalami hang, THEN THE Watchdog_Timer SHALL me-restart controller; perlindungan terhadap kondisi residen terkunci di luar hanya bergantung pada keberhasilan Watchdog_Timer me-restart controller, dan tidak ada jaminan fail-safe unlocked tambahan jika Watchdog_Timer gagal me-restart.

### Requirement 19: Skema Basis Data & Ingest Idempoten (CODING STANDARDS / NFR)

**User Story:** Sebagai pengembang, saya ingin skema basis data yang terstruktur dan ingest log yang idempoten, sehingga data konsisten dan bebas duplikasi.

#### Acceptance Criteria

1. THE Web_Server SHALL memisahkan skema basis data ke dalam tabel `users`, `cards`, `devices`, dan `access_logs`.
2. THE Web_Server SHALL menyediakan endpoint ingest log offline yang idempoten.
3. IF koneksi terputus di tengah sinkronisasi dan log yang sama dikirim ulang, THEN THE Web_Server SHALL mengabaikan entri duplikat dan tidak menyimpannya dua kali.
