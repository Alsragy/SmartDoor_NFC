# firmware/lib — Modul logika portabel

Direktori ini berisi pustaka C++ **murni dan portabel** (tanpa dependensi
hardware) yang dapat diuji di host melalui `[env:native]` (`pio test -e native`).

Setiap modul berada di subfolder sendiri sesuai konvensi PlatformIO
(`lib/<Nama>/src/...` atau `lib/<Nama>/<Nama>.h`), sehingga dapat dipakai ulang
oleh firmware ESP32 **dan** oleh test host.

## Modul yang akan ditambahkan (Task 22.x)

| Subfolder     | Isi                                                                 | Task  |
|---------------|---------------------------------------------------------------------|-------|
| `decision/`   | Port C++ `accessDecision` + `cryptoVerify` (GRANT/DENY, AES-128 CR) | 22.1  |
| `whitelist/`  | `applyDelta` + verifikasi `db_hash`; serialisasi/parse JSONL offline-log + prune ber-ACK + counter idempotency | 22.2 |
| `security/`   | State machine brute-force (>3 tap tak dikenal), tamper (open tanpa relay), door-ajar (durasi > timeout) | 22.3 |

Modul-modul ini adalah referensi paritas dari modul JS server
(`src/services/*`), divalidasi lewat Property 4, 6, 7, 8, 9, 13, 14, 17
(Task 22.4).

## Modul `whitelist/` (Task 22.2)

Port portabel dari `src/services/whitelistVersion.js`:

| Berkas                | Isi                                                                       |
|-----------------------|---------------------------------------------------------------------------|
| `sha256.h`            | SHA-256 referensi portabel + tipe `Sha256Fn` (hash dapat di-inject)       |
| `whitelist_delta.h/.cpp` | `canonicalizeCard`, `cardHash`, `dbHash`, `activeCards`, `isRemoved`, `applyDelta`, `verifyDbHash`, `applyDeltaVerified`, (de)serialisasi JSON |

API utama (namespace `smartdoor::whitelist`):

- `applyDelta(local, delta)` → `Snapshot` baru (upsert `changed`, hapus
  `removed`, hitung ulang `db_hash` atas kartu aktif).
- `applyDeltaVerified(local, delta, out)` → `bool` konsisten + isi `out`
  (verifikasi `db_hash` hasil terhadap `delta.db_hash`, Property 7).

### Keputusan: SHA-256 referensi disertakan (bukan hanya injeksi)

Instruksi task menawarkan dua opsi (inject primitif mbedtls **atau** sertakan
SHA-256 ringkas). **Dipilih: menyertakan SHA-256 referensi domain-publik**
(`sha256.h`) sehingga `db_hash` dapat dihitung PENUH di host untuk property
test (Task 22.4) tanpa toolchain mbedtls. Primitif tetap diabstraksikan di
balik `Sha256Fn` (default = `referenceSha256Hex`), sehingga firmware ESP32
dapat menyuntik implementasi mbedtls dengan tanda tangan sama tanpa mengubah
logika delta/hash. Serialisasi kanonik memakai pemisah `0x1F` (US) dan prefiks
`sha256:`, identik dengan referensi JS (paritas terverifikasi).

## Modul `offline_log/` (Task 22.2)

Port portabel dari `src/services/offlineLog.js`:

| Berkas                 | Isi                                                                      |
|------------------------|--------------------------------------------------------------------------|
| `offline_log.h/.cpp`   | `serialize`/`parse` JSONL, `pruneAcked`, `dedupeByKey`, `identityKey`, dan model counter idempotency `IdempotencyCounter` + `next`/`peekNext`/`formatId` |

API utama (namespace `smartdoor::offline_log`):

- `serialize(event)` / `parse(line, out)` — satu event = satu baris JSONL
  (round-trip setara, Property 8).
- `pruneAcked(queue, ackedIds)` — buang entri ber-ACK (Req 6.3, Property 9).
- `dedupeByKey(logs)` — dedup per idempotency key (`id`).
- Counter idempotency MURNI: `next(counter)` → `"<deviceId>-<counter>"`
  (zero-pad). **Persistensi ke LittleFS adalah Task 24**; di sini logika murni
  & injectable agar dapat di-test di host. Pola `peekNext` mendukung write-ahead
  (persist nilai baru sebelum dipakai) demi ketahanan reboot (Req 6.4).

## Aturan

- Tidak ada `#include <Arduino.h>` atau akses GPIO/radio di modul `lib/`.
- Alokasi JSON memakai dokumen terukur ArduinoJson (Req 18.3).
- Logika deterministik agar dapat di-property-test di host.
