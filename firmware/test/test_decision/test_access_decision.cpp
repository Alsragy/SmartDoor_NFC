// ============================================================================
// test_access_decision.cpp — Host (native) Unity test suite.
//
// Feature: smart-door-kos-esp32
//   Property 4: Keputusan akses dari whitelist lokal.
//     "Untuk sembarang whitelist dan kartu yang kripto-nya valid, keputusan
//      akses adalah GRANT tepat ketika kartu berstatus bukan Suspended dan
//      belum kedaluwarsa, bahkan tanpa koneksi jaringan; selain itu DENY."
//
// Menguji paritas logika firmware (decision/access_decision.h -> decide())
// dengan Correctness Property 4 referensi JS (src/services/accessDecision.js).
//
// Primitif AES-128 DISUNTIKKAN sebagai fake deterministik (identity-with-
// key-mix berbasis XOR) sehingga logika keputusan "accept IFF response ==
// expected" (decision/crypto_verify.h) dapat diuji di host TANPA AES nyata.
// Lihat crypto_verify.h: "Yang DIUJI di host adalah LOGIKA KEPUTUSAN verify()".
//
// Property-coverage didekati dengan loop generatif berseed tetap (deterministik,
// dapat direproduksi) + kasus batas eksplisit. Unity tidak memiliki generator
// bawaan, jadi kita enumerasikan ruang input secara cerdas.
//
// _Requirements: 3.4, 4.3_ (paritas keputusan offline-first)
// ============================================================================

#include <unity.h>

#include <cstdint>
#include <cstring>

#include "access_decision.h"
#include "crypto_verify.h"

using namespace smartdoor::decision;

// ---------------------------------------------------------------------------
// Fake AES-128 deterministik untuk host (injeksi).
//
// Bukan AES nyata — hanya primitif deterministik & invertibel yang CUKUP untuk
// menguji logika keputusan verify() (accept IFF response == respond(nonce,key)).
// out[i] = in[i] XOR key[i] XOR rotasi-indeks, agar: (a) deterministik,
// (b) bergantung pada SELURUH byte key & nonce, (c) berbeda key -> output beda.
// ---------------------------------------------------------------------------
static bool fakeAes128(const uint8_t key[kBlockSize],
                       const uint8_t in[kBlockSize],
                       uint8_t out[kBlockSize]) {
  if (key == nullptr || in == nullptr || out == nullptr) {
    return false;
  }
  for (size_t i = 0; i < kBlockSize; ++i) {
    uint8_t mixed = static_cast<uint8_t>(in[i] ^ key[i] ^ (key[(i + 7) % kBlockSize] + i));
    out[i] = mixed;
  }
  return true;
}

// Deterministic xorshift32 PRNG — tanpa <random> agar ringan & portabel ESP32.
static uint32_t g_rng = 0x1234ABCDu;
static uint32_t nextRand() {
  uint32_t x = g_rng;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  g_rng = x;
  return x;
}
static void seedRand(uint32_t seed) { g_rng = seed ? seed : 0xDEADBEEFu; }

static void fillRandom(uint8_t* buf, size_t len) {
  for (size_t i = 0; i < len; ++i) {
    buf[i] = static_cast<uint8_t>(nextRand() & 0xFF);
  }
}

// Hitung crypto-valid memakai primitif fake: kartu "jujur" membalas response
// yang benar; penyerang membalas response acak.
static bool computeCryptoValid(const uint8_t* nonce, const uint8_t* key,
                               const uint8_t* response) {
  return verify(fakeAes128, nonce, response, key);
}

// ---------------------------------------------------------------------------
// Oracle referensi Property 4 (independen dari implementasi decide()):
// GRANT iff cryptoValid && card.valid && status efektif ACTIVE && belum expired.
// ---------------------------------------------------------------------------
static bool expectedGrant(bool cryptoValid, const Card& card, int64_t now) {
  if (!card.valid) return false;
  if (!cryptoValid) return false;
  // expired iff has_expiry && now >= expired_at
  if (card.has_expiry && now >= card.expired_at_ms) return false;
  // status efektif harus ACTIVE
  if (card.status != CardStatus::ACTIVE) return false;
  return true;
}

// ===========================================================================
// Tests
// ===========================================================================

// Property 4 — crypto fake harus menerima response jujur, menolak yang salah.
static void test_crypto_fake_roundtrip_and_reject(void) {
  uint8_t key[kBlockSize];
  uint8_t nonce[kBlockSize];
  uint8_t response[kBlockSize];

  seedRand(0xA5A5A5A5u);
  for (int iter = 0; iter < 2000; ++iter) {
    fillRandom(key, kBlockSize);
    fillRandom(nonce, kBlockSize);

    // Response jujur = respond(nonce, key) -> harus diterima.
    FnAes128 cipher(fakeAes128);
    TEST_ASSERT_TRUE(respond(cipher, nonce, key, response));
    TEST_ASSERT_TRUE(computeCryptoValid(nonce, key, response));

    // Ubah satu byte response secara acak -> harus ditolak.
    uint8_t idx = static_cast<uint8_t>(nextRand() % kBlockSize);
    uint8_t orig = response[idx];
    uint8_t delta = static_cast<uint8_t>((nextRand() & 0xFF) | 1);  // != 0
    response[idx] = static_cast<uint8_t>(orig ^ delta);
    TEST_ASSERT_FALSE(computeCryptoValid(nonce, key, response));
  }
}

// Property 4 — enumerasi penuh seluruh (status x has_expiry x expired?) dengan
// cryptoValid true/false; GRANT tepat pada kombinasi yang benar.
static void test_prop4_boundary_enumeration(void) {
  const CardStatus statuses[] = {CardStatus::UNPROVISIONED, CardStatus::ACTIVE,
                                 CardStatus::SUSPENDED, CardStatus::REVOKED};
  const int64_t now = 1'000'000;

  for (bool cryptoValid : {false, true}) {
    for (CardStatus st : statuses) {
      // (a) tanpa masa berlaku
      {
        Card card = Card::withStatus(st);
        Outcome o = decide(cryptoValid, card, now);
        bool expect = expectedGrant(cryptoValid, card, now);
        TEST_ASSERT_EQUAL(expect, o.granted());
      }
      // (b) belum kedaluwarsa (expired_at > now)
      {
        Card card = Card::withExpiry(st, now + 1);
        Outcome o = decide(cryptoValid, card, now);
        TEST_ASSERT_EQUAL(expectedGrant(cryptoValid, card, now), o.granted());
      }
      // (c) tepat pada batas (expired_at == now) -> kedaluwarsa (>=) -> DENY
      {
        Card card = Card::withExpiry(st, now);
        Outcome o = decide(cryptoValid, card, now);
        TEST_ASSERT_FALSE(o.granted());  // selalu DENY di batas eksklusif
        TEST_ASSERT_EQUAL(expectedGrant(cryptoValid, card, now), o.granted());
      }
      // (d) sudah kedaluwarsa (expired_at < now)
      {
        Card card = Card::withExpiry(st, now - 1);
        Outcome o = decide(cryptoValid, card, now);
        TEST_ASSERT_FALSE(o.granted());
        TEST_ASSERT_EQUAL(expectedGrant(cryptoValid, card, now), o.granted());
      }
    }
  }

  // Kartu tidak ada (UNKNOWN) -> selalu DENY, alasan UNKNOWN_CARD.
  {
    Card none = Card::none();
    Outcome o = decide(true, none, now);
    TEST_ASSERT_FALSE(o.granted());
    TEST_ASSERT_EQUAL(static_cast<int>(DenyReason::UNKNOWN_CARD),
                      static_cast<int>(o.reason));
  }
}

// Property 4 — generatif: untuk banyak (kartu, now, crypto) acak, decide()
// setuju dengan oracle referensi. Mendekati "untuk sembarang whitelist/kartu".
static void test_prop4_generative_matches_oracle(void) {
  seedRand(0x0C0FFEE1u);
  const CardStatus statuses[] = {CardStatus::UNPROVISIONED, CardStatus::ACTIVE,
                                 CardStatus::SUSPENDED, CardStatus::REVOKED};

  uint8_t key[kBlockSize], nonce[kBlockSize], response[kBlockSize];

  for (int iter = 0; iter < 5000; ++iter) {
    // Rakit kartu acak.
    Card card;
    card.valid = (nextRand() & 0x7) != 0;  // ~87% valid
    card.status = statuses[nextRand() % 4];
    card.has_expiry = (nextRand() & 1) != 0;
    int64_t now = static_cast<int64_t>(nextRand());
    if (card.has_expiry) {
      // expiry di sekitar now (sebagian sebelum, sebagian sesudah, sebagian =)
      int64_t jitter = static_cast<int64_t>(nextRand() % 7) - 3;  // -3..+3
      card.expired_at_ms = now + jitter;
    }

    // crypto valid acak via primitif fake.
    fillRandom(key, kBlockSize);
    fillRandom(nonce, kBlockSize);
    bool honest = (nextRand() & 1) != 0;
    if (honest) {
      FnAes128 cipher(fakeAes128);
      respond(cipher, nonce, key, response);  // response benar
    } else {
      fillRandom(response, kBlockSize);  // kemungkinan besar salah
    }
    bool cryptoValid = computeCryptoValid(nonce, key, response);

    Outcome o = decide(cryptoValid, card, now);
    bool expect = expectedGrant(cryptoValid, card, now);
    TEST_ASSERT_EQUAL_MESSAGE(expect, o.granted(),
                              "decide() tidak sesuai oracle Property 4");
  }
}

// Property 4 (offline invariance) — decide() tidak bergantung pada jaringan;
// modul murni tanpa I/O. Keputusan hanya fungsi (crypto, card, now): memanggil
// ulang dengan input sama memberi hasil identik (determinisme).
static void test_prop4_deterministic_offline(void) {
  Card card = Card::withExpiry(CardStatus::ACTIVE, 5000);
  Outcome a = decide(true, card, 4999);
  Outcome b = decide(true, card, 4999);
  TEST_ASSERT_EQUAL(static_cast<int>(a.result), static_cast<int>(b.result));
  TEST_ASSERT_EQUAL(static_cast<int>(a.reason), static_cast<int>(b.reason));
  TEST_ASSERT_TRUE(a.granted());
}

// ---------------------------------------------------------------------------
// Unity runner (native + embedded).
// ---------------------------------------------------------------------------
void setUp(void) {}
void tearDown(void) {}

static int runAll(void) {
  UNITY_BEGIN();
  RUN_TEST(test_crypto_fake_roundtrip_and_reject);
  RUN_TEST(test_prop4_boundary_enumeration);
  RUN_TEST(test_prop4_generative_matches_oracle);
  RUN_TEST(test_prop4_deterministic_offline);
  return UNITY_END();
}

#ifdef ARDUINO
#include <Arduino.h>
void setup() { runAll(); }
void loop() {}
#else
int main(void) { return runAll(); }
#endif
