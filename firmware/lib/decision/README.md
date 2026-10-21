# lib/decision — Keputusan akses & verifikasi kripto (portabel)

Port C++ **murni, header-only, tanpa dependensi hardware** dari modul server
JS:

| Header               | Port dari                          | Isi                                                        |
|----------------------|------------------------------------|------------------------------------------------------------|
| `access_decision.h`  | `src/services/accessDecision.js`   | `effectiveStatus`, `isExpired`, `decide` → GRANT/DENY       |
| `crypto_verify.h`    | `src/services/cryptoVerify.js`     | `verify` challenge-response AES-128 (logika keputusan murni) |

Kedua header berada di namespace `smartdoor::decision`, C++17, **tanpa**
`#include <Arduino.h>` atau akses GPIO/radio — sehingga dikompilasi sama persis
untuk `[env:esp32dev]` dan `[env:native]` (`pio test -e native`).

## Keputusan akses (`access_decision.h`)

```cpp
using namespace smartdoor::decision;

Card c = Card::withExpiry(CardStatus::ACTIVE, /*expired_at_ms=*/1751328000000LL);
Outcome o = decide(/*cryptoValid=*/true, c, /*nowMs=*/1700000000000LL);
// o.result == Decision::GRANT  (kripto valid, ACTIVE, belum kedaluwarsa)
```

`decide` → `GRANT` **iff** `cryptoValid == true` **dan** status efektif `ACTIVE`
**dan** belum kedaluwarsa (`now < expired_at`); selain itu `DENY` dengan alasan
stabil (`UNKNOWN_CARD`, `CRYPTO_INVALID`, `EXPIRED`, `STATUS_*`). Status efektif
kartu menjadi `SUSPENDED` tepat saat `now >= expired_at` (billing-lock, Req 9.2).
Keputusan murni berbasis whitelist lokal → tetap berlaku **offline** (Req 3.4,
4.2). Modul hanya mengembalikan GRANT/DENY; aktuasi relay ada di lapisan atas
(Req 1.5).

## Verifikasi kripto (`crypto_verify.h`) — pemisahan primitif AES

Ini adalah inti portabilitasnya. Primitif **AES-128 satu blok DIABSTRAKSIKAN**
(injeksi dependensi) — modul **tidak** memuat implementasi AES:

- **ESP32 (`[env:esp32dev]`):** lapisan firmware menyuntikkan primitif yang
  di-back **mbedtls** (`mbedtls_aes_crypt_ecb`).
- **Host (`[env:native]`, Task 22.4):** test menyuntikkan **fake deterministik**
  atau **AES referensi kecil** — tanpa butuh mbedtls di host.

Yang **diuji di host** adalah **logika keputusan** `verify()`:
accept **iff** `response == AES-128(nonce, key)`, dibandingkan **constant-time**,
dan **DENY** untuk input bermasalah (pointer null / primitif gagal, Req 1.5).
Logika ini deterministik dan tidak bergantung pada AES nyata karena primitifnya
disuntikkan.

Dua gaya injeksi tersedia:

```cpp
// 1) Interface (boleh membawa state, mis. handle mbedtls_aes_context):
class MyAes : public smartdoor::decision::Aes128BlockCipher { ... };

// 2) Function pointer untuk primitif bebas-state (mis. test fake):
bool fakeAes(const uint8_t key[16], const uint8_t in[16], uint8_t out[16]);
bool ok = smartdoor::decision::verify(fakeAes, nonce, response, key);
```

## Dipakai oleh

- Firmware task NFC/keputusan (Task 25) & aktuasi (Task 29).
- Host unit + property test (Task 22.4) — paritas Property 4 & 5, dan logika
  verify kripto.

> Task 22.1 hanya menyediakan modul portabel ini. Test host ditulis di Task 22.4.
