# firmware/data — Template LittleFS

Isi direktori ini di-flash ke partisi **LittleFS** perangkat dengan:

```bash
pio run -t uploadfs
```

> Semua nilai di sini adalah **CONTOH / PLACEHOLDER non-rahasia** dan ditandai
> jelas. Ganti sebelum deployment produksi.

## Tata Letak LittleFS (design.md — "Tata Letak LittleFS")

```
/whitelist.json        # daftar kartu valid + status + expired_at + versi/hash DB
/offline_logs.jsonl    # antrean log (satu JSON per baris)
/config.json           # parameter pintu + jaringan
/device.key            # kunci enkripsi lokal untuk melindungi diversified_key
```

### `whitelist.json` (Req 4.1)

Objek dengan `db_version` (monotonik), `db_hash` (SHA-256 daftar card_hash
terurut), dan array `cards`. Tiap kartu:

| Field        | Keterangan                                                      |
|--------------|-----------------------------------------------------------------|
| `uid`        | UID kartu (hex string)                                          |
| `key_version`| versi kunci terdiversifikasi                                   |
| `key_params` | base64 dari diversified_key **terenkripsi** dengan `device.key` |
| `status`     | `ACTIVE` \| `SUSPENDED` (kartu dicabut dihapus total — Req 10) |
| `expired_at` | ISO-8601 UTC; `now >= expired_at` ⇒ Suspended                   |

`db_version` + `db_hash` menjadi dasar Delta_Sync (Req 4.3).

### `offline_logs.jsonl` (Req 5.1)

Append-only, **satu objek JSON per baris** (tahan korupsi parsial). Shape tiap
baris:

```json
{"id":"dev01-000017","ts":"2025-06-18T09:12:03Z","uid":"04A2B3C4D5","result":"GRANT","sync_type":"CACHED_OFFLINE"}
```

- `id` = idempotency key = `deviceId + "-" + counterMonotonikPersisten`
  (counter disimpan persisten agar unik lintas reboot).
- `ts` = timestamp ISO-8601 UTC dari RTC DS3231.
- `result` ∈ `GRANT | DENY`; `sync_type` biasanya `CACHED_OFFLINE` di antrean.

### `config.json`

Parameter pintu + jaringan:

| Field                 | Contoh                              |
|-----------------------|-------------------------------------|
| `device_id`           | id perangkat (prefix idempotency)   |
| `lock_open_duration_s`| durasi relay terbuka (detik)        |
| `door_ajar_timeout_s` | ambang alarm door-ajar (detik)      |
| `api_key`             | API_Key ke Web_Server               |
| `wifi.ssid`           | SSID WiFi (**RAHASIA** — ganti)     |
| `wifi.password`       | password WiFi (**RAHASIA** — ganti) |
| `mqtt.host/port`      | broker MQTT                         |
| `mqtt.base_topic`     | prefix topik (`smartdoor`)          |
| `whitelist_url`       | endpoint unduh whitelist/delta      |

> `wifi.ssid` / `wifi.password` dimuat `setupStorageAndTime()` ke
> `ctx.config.wifi` dan dipakai `wifiTask` (`WiFi.begin`). **RAHASIA**: bersumber
> dari `config.json`/NVS saat provisioning, tidak pernah di-hardcode di sumber.

### `device.key` — CATATAN KEAMANAN

- Kunci enkripsi lokal yang melindungi `diversified_key` per kartu.
- **Produksi:** simpan di **NVS terenkripsi / ESP32 flash encryption**, bukan
  sebagai berkas datar. Firmware **tidak pernah** menyimpan Master_Key
  (design.md — "Least storage of secrets").
- Repo ini hanya menyertakan `device.key.sample` (placeholder palsu). JANGAN
  commit kunci nyata. Buat `device.key` asli saat provisioning perangkat dan
  pastikan ia tidak masuk kontrol versi.
