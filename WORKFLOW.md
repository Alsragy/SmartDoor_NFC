# Panduan Workflow — Smart Door KOS NFC

Dokumen ini menjelaskan **cara kerja (workflow)** dan **cara penggunaan** sistem
Smart Door KOS NFC untuk dua peran:

1. **Owner / Pengelola Kos** — orang yang mengelola kamar, penghuni, kartu, dan pintu.
2. **Pemakai NFC (Penghuni)** — orang yang menempelkan kartu NFC untuk membuka pintu.

Sistem terdiri dari dua bagian:

- **Web Server (dashboard + REST API)** — dijalankan dengan Node.js (`src/`). Ini
  adalah "pusat kendali" milik owner.
- **Firmware ESP32 (pintu)** — dipasang di tiap pintu (`firmware/`). Membaca kartu
  NFC, memutuskan buka/tolak, dan tetap bekerja walau internet mati (mode offline).

Keduanya saling bertukar data lewat **MQTT** (perintah & status real-time) dan
**REST API** (provisioning, whitelist, log offline).

---

## 1. Konsep Dasar

| Istilah | Arti singkat |
|---|---|
| **Device** | Satu ESP32 = satu pintu. Punya `device_id`, mis. `dev01`. |
| **Resident** | Penghuni kos (identitas orang). |
| **Room** | Kamar. Satu kamar dipetakan ke satu penghuni/kartu. |
| **Card (Kartu NFC)** | Kartu fisik penghuni, diidentifikasi lewat `uid`. |
| **Provisioning** | Proses menulis kunci unik ke kartu + mendaftarkannya agar bisa dipakai. |
| **Whitelist** | Daftar kartu yang boleh membuka sebuah pintu. Disinkron ke firmware. |
| **API Key** | Kunci rahasia untuk mengakses API/dashboard. Wajib di tiap request `/api/*`. |

### Status Kartu

| Status | Arti |
|---|---|
| `ACTIVE` | Kartu valid & aktif — bisa membuka pintu. |
| `SUSPENDED` | Ditangguhkan sementara (mis. sewa jatuh tempo / billing-lock). |
| `REVOKED` | Dicabut permanen — dihapus dari whitelist pintu. |
| `UNPROVISIONED` | Provisioning gagal / belum selesai — belum bisa dipakai. |

---

## 2. Workflow untuk OWNER / Pengelola Kos

Owner bekerja lewat **dashboard web** atau **REST API**. Semua jalur `/api/*`
dilindungi API Key (dikirim di header `x-api-key`).

### 2.1 Menjalankan Server (sekali di awal)

```bash
# Install dependency
npm install

# (opsional) arahkan ke broker MQTT agar perintah real-time ke pintu aktif
# PowerShell:
$env:SMARTDOOR_MQTT_URL = "mqtt://broker-anda:1883"

# Jalankan server (default port 3000)
node src/app.js
```

Dashboard tersedia di `http://localhost:3000`. Jika `SMARTDOOR_MQTT_URL` tidak
diisi, server tetap jalan untuk kelola data, hanya perintah real-time ke pintu
(unlock/revoke/suspend/config/ota) yang belum terkirim sampai MQTT dihubungkan.

### 2.2 Alur Harian Owner (ringkas)

```
Tambah Penghuni  →  Tambah/Pilih Kamar  →  Provisioning Kartu
      │                                            │
      └────────────────────────────┬──────────────┘
                                    ▼
                         Kartu ACTIVE & masuk Whitelist pintu
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
   Penghuni keluar/nunggak     Kartu hilang/dicabut      Pantau akses & alert
   → Suspend (billing-lock)    → Revoke permanen         → dashboard / log
```

### 2.3 Langkah Detail

**A. Daftarkan Penghuni (Resident)**
- Tambahkan data penghuni (nama/identitas) lewat menu Residents / `POST /api/residents`.

**B. Siapkan Kamar (Room)**
- Daftarkan kamar lewat Rooms / `POST /api/rooms`.

**C. Provisioning Kartu NFC**  → inti pemberian akses
- Jalankan provisioning: `POST /api/provisioning`
  ```json
  { "uid": "04A1B2C3", "resident_id": 1, "room_id": 1, "expired_at": "2026-12-31T23:59:59Z" }
  ```
- Sistem akan:
  1. Menurunkan kunci unik (Diversified Key) dari Master Key + UID kartu.
  2. Menulis kunci itu ke kartu fisik (lewat NFC writer).
  3. Jika sukses → kartu jadi `ACTIVE`, masuk whitelist, `db_version` dinaikkan.
  4. Jika gagal → kartu ditandai `UNPROVISIONED` (ulangi provisioning).
- `expired_at` dipakai untuk **billing-lock** (lihat poin F).

**D. Sinkronisasi ke Pintu (otomatis)**
- Firmware pintu menarik perubahan whitelist lewat delta-sync
  (`GET /api/devices/:dev/whitelist`) dan/atau menerima perintah via MQTT.
- Owner tidak perlu aksi manual — cukup pastikan pintu online secara berkala.

**E. Membuka Pintu dari Jarak Jauh (opsional)**
- Owner bisa mengirim perintah buka: `POST /api/devices/:dev/unlock`.
- Server mem-publish `cmd/unlock` ke pintu via MQTT.

**F. Suspend Otomatis saat Jatuh Tempo (Billing-Lock)**
- Scheduler berjalan periodik (default tiap menit).
- Kartu dengan `expired_at <= sekarang` otomatis jadi `SUSPENDED`, dan perintah
  `cmd/suspend` dikirim ke pintu. Penghuni yang menunggak otomatis tertolak.
- Jika sinkron ke pintu gagal, server mencoba ulang otomatis di scan berikutnya.
- Untuk mengaktifkan kembali: perpanjang `expired_at` / re-provisioning.

**G. Mencabut Kartu (Revoke)**  → saat kartu hilang/penghuni keluar permanen
- Jalankan: `POST /api/cards/:uid/revoke`.
- Kartu jadi `REVOKED`, dihapus dari whitelist, dan `cmd/revoke` dikirim ke pintu.

**H. Atur Konfigurasi Pintu**
- `PUT /api/devices/:dev/config` untuk mengatur mis. durasi buka kunci
  (`lock_open_duration_s`) dan timeout pintu terbuka (`door_ajar_timeout_s`).

**I. Update Firmware (OTA)**
- `POST /api/devices/:dev/ota` untuk mengirim URL + checksum firmware baru.

**J. Pantau Kesehatan & Keamanan**
- **Heartbeat**: pintu mengirim `heartbeat` (RSSI, sisa storage, versi DB) —
  lihat status online tiap pintu di dashboard.
- **Live feed**: `GET /api/feed` (SSE) menampilkan log akses & alert real-time.
- **Alert keamanan**: `event/tamper` (pintu dibuka paksa) dan `event/bruteforce`
  (percobaan kartu salah berulang) tampil otomatis di dashboard.
- **Log akses**: log GRANT/DENY dari pintu, termasuk yang `CACHED_OFFLINE`
  (dikumpulkan saat pintu offline, lalu disinkron saat online lagi).

---

## 3. Workflow untuk PEMAKAI NFC (Penghuni)

Penghuni tidak memakai dashboard. Cukup memakai kartu di pintu.

### 3.1 Alur Pemakaian

```
Tempelkan kartu ke pintu
          │
          ▼
Pintu membaca UID & memverifikasi kunci kartu
          │
   ┌──────┴───────────────────────────────┐
   ▼                                        ▼
Kartu ACTIVE & ada di whitelist       Kartu tidak valid / SUSPENDED / REVOKED
   → Pintu TERBUKA (GRANT)                 → Pintu TETAP TERKUNCI (DENY)
```

### 3.2 Yang Perlu Diketahui Penghuni

- **Tempelkan kartu** di area reader pintu, tunggu respons (buka / tolak).
- Pintu **tetap bekerja walau internet mati**: keputusan buka/tolak dibuat lokal
  oleh firmware berdasarkan whitelist tersimpan. Log akses disimpan offline dan
  dikirim ke server saat koneksi pulih.
- **Kartu ditolak?** Kemungkinan penyebab:
  - Masa aktif/sewa habis → kartu `SUSPENDED` (hubungi owner untuk perpanjang).
  - Kartu dicabut → `REVOKED` (mis. dilaporkan hilang).
  - Provisioning belum selesai → `UNPROVISIONED` (minta owner provisioning ulang).
- **Kartu hilang?** Segera lapor owner agar di-**revoke** supaya tidak disalahgunakan.
- Jangan mencoba menempel kartu berkali-kali dengan paksa — percobaan gagal
  berulang memicu alert **bruteforce** ke owner.

---

## 4. Ringkasan Endpoint (Referensi Owner)

> Semua endpoint `/api/*` wajib menyertakan header `x-api-key: <API_KEY>`.

| Aksi | Method & Path |
|---|---|
| Kelola penghuni | `/api/residents` |
| Kelola kamar | `/api/rooms` |
| Kelola kartu | `/api/cards` |
| Provisioning kartu | `POST /api/provisioning` |
| Ambil whitelist pintu | `GET /api/devices/:dev/whitelist` |
| Terima log offline pintu | `POST /api/devices/:dev/offline-logs` |
| Buka pintu jarak jauh | `POST /api/devices/:dev/unlock` |
| Cabut kartu | `POST /api/cards/:uid/revoke` |
| Konfigurasi pintu | `PUT /api/devices/:dev/config` |
| Update firmware (OTA) | `POST /api/devices/:dev/ota` |
| Live feed (SSE) | `GET /api/feed` |

### Topik MQTT

Struktur: `smartdoor/{device_id}/<subtopik>`

- **Pintu → Server**: `heartbeat`, `log`, `event/tamper`, `event/bruteforce`
- **Server → Pintu**: `cmd/unlock`, `cmd/revoke`, `cmd/suspend`, `cmd/config`, `cmd/ota`

---

## 5. Tips Operasional

- **Simpan Master Key & API Key dengan aman** — jangan commit ke git. Keduanya
  kunci keamanan seluruh sistem.
- **Pastikan pintu rutin online** agar perubahan (suspend/revoke/config) cepat
  tersinkron. Jika telat sinkron, server otomatis mengulang.
- **Gunakan `expired_at`** untuk otomatisasi billing — penghuni nunggak tertolak
  tanpa aksi manual.
- **Pantau alert tamper/bruteforce** sebagai indikasi gangguan keamanan fisik.
