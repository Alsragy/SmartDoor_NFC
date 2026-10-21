// ============================================================================
// crypto_verify.h — Verifikasi challenge-response AES-128 portabel (port C++
// dari src/services/cryptoVerify.js) — Smart Door KOS ESP32.
//
// Mengimplementasikan Skema A (DESFire) dari design.md "Lapisan Verifikasi NFC
// Kripto":
//   1. Firmware/reader kirim nonce acak (challenge) ke kartu.
//   2. Kartu balas response = AES-128(nonce, diversified_key).
//   3. Firmware menerima IFF response == AES-128(nonce, diversified_key).
// Verifikasi kriptografis — UID bukan satu-satunya faktor (Req 1.1). Gagal →
// DENY, relay diam (Req 1.5). Modul ini hanya menghasilkan keputusan boolean.
//
// -------------------------------------------------------------------------
// PEMISAHAN PENTING: primitif AES vs. logika keputusan (yang diuji di host)
// -------------------------------------------------------------------------
// Primitif kripto (AES-128 satu blok) DIABSTRAKSIKAN sebagai fungsi yang
// disuntikkan (dependency injection). Modul ini TIDAK memuat implementasi AES:
//
//   * Di ESP32 ([env:esp32dev]): primitif di-back oleh mbedtls
//     (mbedtls_aes_crypt_ecb), diinjeksikan oleh lapisan firmware.
//   * Di host ([env:native], Task 22.4): test menyuntikkan fake deterministik
//     atau AES referensi kecil — TANPA butuh mbedtls di host.
//
// Yang DIUJI di host adalah LOGIKA KEPUTUSAN verify(): equality constant-time
// (accept IFF response == expected) dan ketahanan terhadap input bermasalah.
// Logika ini murni & deterministik; tidak bergantung pada AES nyata karena
// primitif AES-nya disuntikkan. Inilah inti portabilitas modul.
//
// TIDAK ADA #include <Arduino.h> / mbedtls di header ini. Dikompilasi sama
// untuk esp32dev & native. Hanya header C++17 standar.
//
// _Requirements: 1.1, 1.5, 3.4, 4.2, 9.3_
// ============================================================================

#ifndef SMARTDOOR_DECISION_CRYPTO_VERIFY_H
#define SMARTDOOR_DECISION_CRYPTO_VERIFY_H

#include <cstddef>
#include <cstdint>

namespace smartdoor {
namespace decision {

// Ukuran blok / nonce / kunci / response AES-128 dalam byte (128 bit).
// Setara BLOCK_SIZE di cryptoVerify.js.
static constexpr size_t kBlockSize = 16;

// ---------------------------------------------------------------------------
// Primitif AES-128 satu blok (abstraksi injeksi).
//
// Enkripsi SATU blok (16 byte) `in` dengan `key` (16 byte) → `out` (16 byte),
// setara AES-128-ECB tanpa padding (sisi "kartu" pada challenge-response).
// Implementasi konkret disediakan lapisan firmware (mbedtls) atau test host.
//
// Kontrak: out != nullptr, in != nullptr, key != nullptr; masing-masing
// menunjuk ke buffer berukuran kBlockSize. Kembalikan true bila enkripsi
// berhasil, false bila primitif gagal (verify akan DENY bila gagal).
//
// Dibuat sebagai interface agar bisa membawa state/konteks (mis. handle
// mbedtls_aes_context) tanpa variabel global. Untuk kasus bebas-state,
// gunakan AesEncryptFn (function pointer) + FnAes128 di bawah.
// ---------------------------------------------------------------------------
class Aes128BlockCipher {
 public:
  virtual ~Aes128BlockCipher() = default;

  // Enkripsi satu blok. Semua pointer menunjuk buffer kBlockSize byte.
  virtual bool encryptBlock(const uint8_t key[kBlockSize],
                            const uint8_t in[kBlockSize],
                            uint8_t out[kBlockSize]) const = 0;
};

// Varian function-pointer untuk primitif tanpa state (mis. test fake atau
// pembungkus statis mbedtls). Tanda tangan sama dengan encryptBlock.
using AesEncryptFn = bool (*)(const uint8_t key[kBlockSize],
                              const uint8_t in[kBlockSize],
                              uint8_t out[kBlockSize]);

// Adapter: bungkus AesEncryptFn menjadi Aes128BlockCipher.
class FnAes128 final : public Aes128BlockCipher {
 public:
  explicit FnAes128(AesEncryptFn fn) : fn_(fn) {}

  bool encryptBlock(const uint8_t key[kBlockSize],
                    const uint8_t in[kBlockSize],
                    uint8_t out[kBlockSize]) const override {
    if (fn_ == nullptr) {
      return false;
    }
    return fn_(key, in, out);
  }

 private:
  AesEncryptFn fn_;
};

// ---------------------------------------------------------------------------
// constantTimeEqual(a, b, len) — perbandingan waktu-konstan untuk menghindari
// kebocoran timing (setara crypto.timingSafeEqual di JS). Selalu menyentuh
// seluruh `len` byte; tidak short-circuit pada byte pertama yang berbeda.
// ---------------------------------------------------------------------------
inline bool constantTimeEqual(const uint8_t* a, const uint8_t* b, size_t len) {
  if (a == nullptr || b == nullptr) {
    return false;
  }
  uint8_t diff = 0;
  for (size_t i = 0; i < len; ++i) {
    diff = static_cast<uint8_t>(diff | (a[i] ^ b[i]));
  }
  return diff == 0;
}

// ---------------------------------------------------------------------------
// respond(cipher, nonce, key, out) — hitung response kartu atas challenge:
// out = AES-128(nonce, diversifiedKey). Sisi "kartu" (Req 1.3). Dipakai untuk
// round-trip test (Property 2) & sebagai dasar verify().
//
// Semua buffer berukuran kBlockSize. Kembalikan true bila primitif berhasil.
// ---------------------------------------------------------------------------
inline bool respond(const Aes128BlockCipher& cipher,
                    const uint8_t nonce[kBlockSize],
                    const uint8_t key[kBlockSize],
                    uint8_t out[kBlockSize]) {
  if (nonce == nullptr || key == nullptr || out == nullptr) {
    return false;
  }
  return cipher.encryptBlock(key, nonce, out);
}

// ---------------------------------------------------------------------------
// verify(cipher, nonce, response, key) — LOGIKA KEPUTUSAN kripto (inti yang
// diuji di host). Terima IFF `response` cocok dengan respond(nonce, key),
// dibandingkan secara constant-time (Req 1.1).
//
// Tahan input bermasalah: pointer null atau primitif gagal → false (DENY,
// Req 1.5), tidak melempar. Kartu yang hanya meniru UID atau mengirim response
// salah selalu ditolak.
//
// Semua buffer berukuran kBlockSize (challenge-response AES-128 selalu
// 16 byte; panjang divalidasi oleh lapisan pemanggil / protokol).
// ---------------------------------------------------------------------------
inline bool verify(const Aes128BlockCipher& cipher,
                   const uint8_t nonce[kBlockSize],
                   const uint8_t response[kBlockSize],
                   const uint8_t key[kBlockSize]) {
  if (nonce == nullptr || response == nullptr || key == nullptr) {
    return false;
  }

  uint8_t expected[kBlockSize] = {0};
  if (!respond(cipher, nonce, key, expected)) {
    return false;  // primitif gagal → DENY
  }

  return constantTimeEqual(expected, response, kBlockSize);
}

// Overload praktis memakai function pointer langsung.
inline bool verify(AesEncryptFn aesFn,
                   const uint8_t nonce[kBlockSize],
                   const uint8_t response[kBlockSize],
                   const uint8_t key[kBlockSize]) {
  FnAes128 cipher(aesFn);
  return verify(cipher, nonce, response, key);
}

}  // namespace decision
}  // namespace smartdoor

#endif  // SMARTDOOR_DECISION_CRYPTO_VERIFY_H
