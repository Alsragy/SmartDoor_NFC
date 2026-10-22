# Panduan Demo — Smart Door KOS NFC

Dokumen ini berisi langkah **mendemokan proyek** dari yang paling cepat sampai
paling lengkap. Semua perintah ditulis untuk **PowerShell (Windows)**.

> Catatan penting sebelum mulai:
> - **Dashboard web tersedia** di `src/public` (`index.html` + `app.css` +
>   `app.js`), disajikan otomatis oleh server di `http://localhost:3000`.
>   Inilah cara demo termudah (lihat **Cara 0**).
> - **API Key wajib**. Tanpa env `SMARTDOOR_API_KEY`, server menolak SEMUA
>   request `/api/*` dengan `401` (ini fitur keamanan *fail-closed*, bagus untuk
>   ditonjolkan saat demo).
> - `sensor.js` di root kosong — abaikan.

---

## Cara 0 — Demo Dashboard Web (termudah, paling cocok untuk presentasi)

Semua aksi owner dilakukan lewat UI klik-klik, tanpa perlu `curl`.

### Langkah 1 — Jalankan server

```powershell
$env:SMARTDOOR_API_KEY = "demo-key-123"
node src/app.js
```

### Langkah 2 — Buka dashboard

Buka browser ke **`http://localhost:3000`**.

### Langkah 3 — Masukkan API Key

Di pojok kanan atas, ketik `demo-key-123` pada kolom **API Key** lalu klik
**Simpan**. Badge berubah menjadi **Terhubung** (hijau) dan semua panel langsung
terisi. Key disimpan di browser, jadi saat dibuka lagi otomatis tersambung.

### Langkah 4 — Peragakan alur owner (semua lewat UI)

1. **Tambah Penghuni** — isi nama (+ no. HP opsional) → *Tambah Penghuni*.
2. **Tambah Kamar** — isi nomor kamar (mis. `A-01`), `device_id` opsional.
3. **Provisioning Kartu** — isi `uid`, `resident_id`, `room_id` (lihat id pada
   panel "Penghuni & Kamar"), dan masa aktif (opsional). Kartu muncul di tabel
   dengan badge **ACTIVE**.
4. **Revoke** — klik tombol *Revoke* di baris kartu → badge jadi **REVOKED**.
5. **Unlock** — klik tombol *Unlock* di baris pintu → perintah dikirim ke broker
   MQTT (butuh `SMARTDOOR_MQTT_URL`, lihat Cara 3).

### Yang ditampilkan dashboard

- **Kartu ringkasan**: jumlah penghuni, kamar, kartu aktif, pintu online.
- **Tabel Kartu** dengan badge status berwarna + tombol Revoke.
- **Tabel Pintu** (ONLINE/OFFLINE, RSSI, versi DB) + tombol Unlock.
- **Live Feed** real-time (SSE): akses GRANT (hijau) / DENY (merah) dan alert
  tamper/bruteforce (kuning).

> **Catatan teknis:** live feed memakai `fetch` streaming (bukan `EventSource`)
> agar bisa mengirim header `x-api-key` yang diwajibkan server; frame SSE
> (`event:` / `data:`) diparse manual di `app.js`.

> **Tanpa broker MQTT**, panel Pintu & Live Feed tetap tampil namun kosong
> karena belum ada perangkat yang mengirim data. Fungsi kelola data (penghuni,
> kamar, kartu) tetap berjalan penuh.

---

## Persiapan (sekali)

```powershell
npm install
```

---

## Cara 1 — Demo Test Suite (paling cepat, pasti jalan)

Menunjukkan bahwa seluruh logika inti terbukti benar lewat 85 unit/property test.

```powershell
npm test
```

Hasil yang diharapkan (sudah diverifikasi):

```
Test Files  21 passed (21)
     Tests  85 passed (85)
```

**Cerita saat demo:** jelaskan bahwa test mencakup keputusan akses
(GRANT/DENY), billing-lock otomatis, delta-sync whitelist, idempotency log
offline, dan verifikasi kripto — jadi perilaku sistem terjamin, bukan sekadar
"katanya jalan".

---

## Cara 2 — Demo REST API via Terminal (alternatif tanpa UI)

Alur yang sama dengan **Cara 0**, tapi lewat `curl` — berguna untuk menunjukkan
kontrak API mentah atau saat mendemokan dari terminal.

### Langkah 1 — Jalankan server (Terminal A)

```powershell
$env:SMARTDOOR_API_KEY = "demo-key-123"
node src/app.js
```

Server mendengarkan di `http://localhost:3000`. DB SQLite dibuat otomatis di
`data/smartdoor.db`.

### Langkah 2 — Tunjukkan keamanan fail-closed (Terminal B)

Request tanpa API key → ditolak:

```powershell
curl.exe -i http://localhost:3000/api/residents
# → HTTP/1.1 401 Unauthorized
```

### Langkah 3 — Tambah penghuni (Resident)

```powershell
curl.exe -s -X POST http://localhost:3000/api/residents `
  -H "x-api-key: demo-key-123" `
  -H "Content-Type: application/json" `
  -d '{\"name\":\"Budi\",\"phone\":\"08123456789\"}'
```

### Langkah 4 — Tambah kamar (Room)

```powershell
curl.exe -s -X POST http://localhost:3000/api/rooms `
  -H "x-api-key: demo-key-123" `
  -H "Content-Type: application/json" `
  -d '{\"room_no\":\"A-01\"}'
```

### Langkah 5 — Provisioning kartu NFC

Pakai `resident_id` & `room_id` hasil langkah 3 & 4 (biasanya `1` dan `1` pada DB baru):

```powershell
curl.exe -s -X POST http://localhost:3000/api/provisioning `
  -H "x-api-key: demo-key-123" `
  -H "Content-Type: application/json" `
  -d '{\"uid\":\"04A1B2C3\",\"resident_id\":1,\"room_id\":1,\"expired_at\":\"2026-12-31T23:59:59Z\"}'
```

Kartu akan menjadi `ACTIVE` dan masuk whitelist.

### Langkah 6 — Lihat kartu

```powershell
curl.exe -s http://localhost:3000/api/cards -H "x-api-key: demo-key-123"
```

### Langkah 7 — Cabut kartu (Revoke)

```powershell
curl.exe -s -X POST http://localhost:3000/api/cards/04A1B2C3/revoke `
  -H "x-api-key: demo-key-123"
```

Kartu menjadi `REVOKED` dan dihapus dari whitelist.

> **Tips demo billing-lock:** set `expired_at` ke waktu yang sudah lewat
> (mis. `2020-01-01T00:00:00Z`) saat provisioning, lalu biarkan scheduler
> berjalan (default tiap menit). Kartu otomatis berpindah ke `SUSPENDED`.

---

## Cara 3 — Demo Real-time MQTT (opsional, paling impresif)

Menunjukkan komunikasi live server ↔ pintu (ESP32).

### Langkah 1 — Siapkan broker MQTT

Pakai broker publik untuk uji cepat, atau Mosquitto lokal:

```powershell
$env:SMARTDOOR_API_KEY = "demo-key-123"
$env:SMARTDOOR_MQTT_URL = "mqtt://test.mosquitto.org:1883"
node src/app.js
```

### Langkah 2 — Buka live feed (Terminal B)

```powershell
curl.exe -N http://localhost:3000/api/feed -H "x-api-key: demo-key-123"
```

Stream SSE ini akan menampilkan log akses & alert secara real-time.

### Langkah 3 — Simulasikan pesan dari pintu

Dengan klien MQTT apa pun (mis. `mosquitto_pub` atau MQTT Explorer), publish ke
topik firmware→server, lalu tunjukkan datanya muncul di live feed / dashboard:

- Heartbeat: `smartdoor/dev01/heartbeat`
- Log akses: `smartdoor/dev01/log`
- Alert: `smartdoor/dev01/event/tamper`, `smartdoor/dev01/event/bruteforce`

Perintah dari server→pintu (`cmd/unlock`, `cmd/revoke`, `cmd/suspend`,
`cmd/config`, `cmd/ota`) terkirim otomatis saat Anda memanggil endpoint terkait
(mis. `POST /api/devices/dev01/unlock`).

---

## Alur Cerita Presentasi (saran urutan)

1. **Masalah**: kos butuh akses pintu aman, otomatis saat sewa habis, dan tetap
   jalan walau internet mati.
2. **Bukti kualitas**: jalankan `npm test` → 85 test lulus.
3. **Alur owner (visual)**: peragakan Cara 0 di dashboard — penghuni → kamar →
   provisioning → revoke, semua klik-klik.
4. **Keamanan**: tunjukkan badge ditolak saat API key salah (fail-closed) +
   billing-lock otomatis (kartu kedaluwarsa jadi SUSPENDED).
5. **Real-time** (jika broker siap): Cara 3 — heartbeat & live feed muncul di
   panel Live Feed dashboard.
6. **Offline-first**: jelaskan pintu tetap memutuskan GRANT/DENY lokal dan log
   disinkron saat online (lihat `WORKFLOW.md`).
7. **(Opsional) kontrak API mentah**: tunjukkan Cara 2 lewat `curl` bagi audiens
   teknis.

---

## Troubleshooting

| Gejala | Penyebab | Solusi |
|---|---|---|
| Semua request `401` / badge "ditolak" | `SMARTDOOR_API_KEY` belum diset atau key di UI salah | Set env, restart server, masukkan key yang sama di dashboard |
| Dashboard kosong terus | API Key belum disimpan (klik **Simpan**) | Masukkan key lalu klik Simpan hingga badge **Terhubung** |
| `curl` tidak dikenal | PowerShell alias | Pakai `curl.exe` (bukan `curl`) |
| Panel Pintu / Live Feed kosong | `SMARTDOOR_MQTT_URL` kosong / belum ada perangkat | Set URL broker (Cara 3); kelola data tetap jalan tanpa MQTT |
| Perintah ke pintu tak terkirim | `SMARTDOOR_MQTT_URL` kosong | Set URL broker lalu restart |
| Port 3000 dipakai | Server lain aktif | `$env:PORT=3001; node src/app.js` (dashboard di `http://localhost:3001`) |
