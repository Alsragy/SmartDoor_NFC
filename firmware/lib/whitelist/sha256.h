// ============================================================================
// sha256.h — Primitif SHA-256 portabel (public-domain reference) + abstraksi
//            fungsi hash yang dapat di-inject.
//
// Smart Door KOS ESP32 — modul logika MURNI (tanpa Arduino.h, tanpa I/O).
//
// Tujuan:
//   - Menyediakan implementasi SHA-256 referensi yang berjalan di host (native)
//     maupun di ESP32, sehingga `card_hash`/`db_hash` dapat dihitung penuh di
//     host tanpa bergantung pada mbedtls (lihat Keputusan Desain di bawah).
//   - Mengekspos tipe `Sha256Fn` (std::function) agar firmware ESP32 BOLEH
//     menyuntikkan implementasi lain (mis. mbedtls) tanpa mengubah logika
//     delta/hash. Secara default digunakan implementasi referensi di sini.
//
// KEPUTUSAN DESAIN (sesuai instruksi task 22.2):
//   Kami MEMILIH menyertakan SHA-256 referensi ringkas (public-domain) di sini
//   agar `dbHash` sepenuhnya dapat dihitung di host untuk property test (22.4).
//   Primitif tetap diabstraksikan di balik `Sha256Fn` sehingga pada ESP32
//   dapat diganti dengan mbedtls bila diinginkan — API hash tidak berubah.
//
// Implementasi SHA-256 di bawah merupakan adaptasi dari implementasi referensi
// domain-publik yang umum (konstanta FIPS 180-4). Deterministik & tanpa state
// global.
//
// _Requirements: 4.3_
// ============================================================================
#ifndef SMARTDOOR_WHITELIST_SHA256_H
#define SMARTDOOR_WHITELIST_SHA256_H

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>

namespace smartdoor {
namespace whitelist {

// --------------------------------------------------------------------------
// Implementasi SHA-256 referensi (FIPS 180-4). Mengembalikan 32 byte digest.
// --------------------------------------------------------------------------
namespace sha256_detail {

inline uint32_t rotr(uint32_t x, uint32_t n) {
  return (x >> n) | (x << (32 - n));
}

struct Context {
  uint32_t state[8];
  uint64_t bitlen;
  uint8_t buffer[64];
  size_t bufferLen;
};

inline void init(Context& ctx) {
  ctx.state[0] = 0x6a09e667u;
  ctx.state[1] = 0xbb67ae85u;
  ctx.state[2] = 0x3c6ef372u;
  ctx.state[3] = 0xa54ff53au;
  ctx.state[4] = 0x510e527fu;
  ctx.state[5] = 0x9b05688cu;
  ctx.state[6] = 0x1f83d9abu;
  ctx.state[7] = 0x5be0cd19u;
  ctx.bitlen = 0;
  ctx.bufferLen = 0;
}

inline void transform(Context& ctx, const uint8_t* data) {
  static const uint32_t k[64] = {
      0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu,
      0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u,
      0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u,
      0xc19bf174u, 0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
      0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau, 0x983e5152u,
      0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
      0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu,
      0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
      0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u,
      0xd6990624u, 0xf40e3585u, 0x106aa070u, 0x19a4c116u, 0x1e376c08u,
      0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu,
      0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
      0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};

  uint32_t m[64];
  for (uint32_t i = 0, j = 0; i < 16; ++i, j += 4) {
    m[i] = (static_cast<uint32_t>(data[j]) << 24) |
           (static_cast<uint32_t>(data[j + 1]) << 16) |
           (static_cast<uint32_t>(data[j + 2]) << 8) |
           (static_cast<uint32_t>(data[j + 3]));
  }
  for (uint32_t i = 16; i < 64; ++i) {
    uint32_t s0 = rotr(m[i - 15], 7) ^ rotr(m[i - 15], 18) ^ (m[i - 15] >> 3);
    uint32_t s1 = rotr(m[i - 2], 17) ^ rotr(m[i - 2], 19) ^ (m[i - 2] >> 10);
    m[i] = m[i - 16] + s0 + m[i - 7] + s1;
  }

  uint32_t a = ctx.state[0];
  uint32_t b = ctx.state[1];
  uint32_t c = ctx.state[2];
  uint32_t d = ctx.state[3];
  uint32_t e = ctx.state[4];
  uint32_t f = ctx.state[5];
  uint32_t g = ctx.state[6];
  uint32_t h = ctx.state[7];

  for (uint32_t i = 0; i < 64; ++i) {
    uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    uint32_t ch = (e & f) ^ ((~e) & g);
    uint32_t temp1 = h + s1 + ch + k[i] + m[i];
    uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    uint32_t temp2 = s0 + maj;

    h = g;
    g = f;
    f = e;
    e = d + temp1;
    d = c;
    c = b;
    b = a;
    a = temp1 + temp2;
  }

  ctx.state[0] += a;
  ctx.state[1] += b;
  ctx.state[2] += c;
  ctx.state[3] += d;
  ctx.state[4] += e;
  ctx.state[5] += f;
  ctx.state[6] += g;
  ctx.state[7] += h;
}

inline void update(Context& ctx, const uint8_t* data, size_t len) {
  for (size_t i = 0; i < len; ++i) {
    ctx.buffer[ctx.bufferLen++] = data[i];
    if (ctx.bufferLen == 64) {
      transform(ctx, ctx.buffer);
      ctx.bitlen += 512;
      ctx.bufferLen = 0;
    }
  }
}

inline void finalize(Context& ctx, uint8_t hash[32]) {
  size_t i = ctx.bufferLen;

  // Padding.
  if (ctx.bufferLen < 56) {
    ctx.buffer[i++] = 0x80;
    while (i < 56) {
      ctx.buffer[i++] = 0x00;
    }
  } else {
    ctx.buffer[i++] = 0x80;
    while (i < 64) {
      ctx.buffer[i++] = 0x00;
    }
    transform(ctx, ctx.buffer);
    for (size_t j = 0; j < 56; ++j) {
      ctx.buffer[j] = 0x00;
    }
  }

  ctx.bitlen += static_cast<uint64_t>(ctx.bufferLen) * 8;
  ctx.buffer[63] = static_cast<uint8_t>(ctx.bitlen);
  ctx.buffer[62] = static_cast<uint8_t>(ctx.bitlen >> 8);
  ctx.buffer[61] = static_cast<uint8_t>(ctx.bitlen >> 16);
  ctx.buffer[60] = static_cast<uint8_t>(ctx.bitlen >> 24);
  ctx.buffer[59] = static_cast<uint8_t>(ctx.bitlen >> 32);
  ctx.buffer[58] = static_cast<uint8_t>(ctx.bitlen >> 40);
  ctx.buffer[57] = static_cast<uint8_t>(ctx.bitlen >> 48);
  ctx.buffer[56] = static_cast<uint8_t>(ctx.bitlen >> 56);
  transform(ctx, ctx.buffer);

  for (uint32_t t = 0; t < 8; ++t) {
    hash[t * 4 + 0] = static_cast<uint8_t>(ctx.state[t] >> 24);
    hash[t * 4 + 1] = static_cast<uint8_t>(ctx.state[t] >> 16);
    hash[t * 4 + 2] = static_cast<uint8_t>(ctx.state[t] >> 8);
    hash[t * 4 + 3] = static_cast<uint8_t>(ctx.state[t]);
  }
}

}  // namespace sha256_detail

// --------------------------------------------------------------------------
// API publik SHA-256
// --------------------------------------------------------------------------

/**
 * Tipe fungsi hash yang dapat di-inject. Menerima byte input dan mengembalikan
 * digest sebagai string heksadesimal lowercase (TANPA prefiks "sha256:").
 *
 * Pada host/native digunakan `referenceSha256Hex`. Pada ESP32 BOLEH diganti
 * dengan implementasi mbedtls dengan tanda tangan yang sama.
 */
using Sha256Fn = std::function<std::string(const std::string&)>;

/** Digest SHA-256 32-byte dari sebuah string input. */
inline void sha256Raw(const std::string& input, uint8_t out[32]) {
  sha256_detail::Context ctx;
  sha256_detail::init(ctx);
  sha256_detail::update(ctx, reinterpret_cast<const uint8_t*>(input.data()),
                        input.size());
  sha256_detail::finalize(ctx, out);
}

/**
 * SHA-256 referensi: kembalikan heksadesimal lowercase (64 char), tanpa
 * prefiks. Deterministik & portabel (host + ESP32).
 */
inline std::string referenceSha256Hex(const std::string& input) {
  uint8_t digest[32];
  sha256Raw(input, digest);

  static const char* hexDigits = "0123456789abcdef";
  std::string hex;
  hex.reserve(64);
  for (int i = 0; i < 32; ++i) {
    hex.push_back(hexDigits[(digest[i] >> 4) & 0x0F]);
    hex.push_back(hexDigits[digest[i] & 0x0F]);
  }
  return hex;
}

}  // namespace whitelist
}  // namespace smartdoor

#endif  // SMARTDOOR_WHITELIST_SHA256_H
