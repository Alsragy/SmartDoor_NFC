// ============================================================================
// test_security_state.cpp — Host (native) Unity test suite.
//
// Feature: smart-door-kos-esp32
//   Property 13: Pemicu deteksi brute-force.
//     "Untuk sembarang urutan tap kartu, event brute-force dipicu tepat ketika
//      terdapat lebih dari 3 tap kartu tak dikenal berturut-turut; tap kartu
//      yang dikenal mereset penghitung."
//   Property 14: Pemicu deteksi tamper.
//     "Untuk sembarang transisi status pintu, event tamper dipicu jika dan hanya
//      jika pintu terbuka sementara relay tidak diaktifkan pada jendela waktu
//      tersebut."
//   Property 17: Alarm door-ajar sesuai timeout.
//     "Untuk sembarang durasi pintu terbuka dan Door_Ajar_Timeout, alarm
//      door-ajar aktif jika dan hanya jika durasi terbuka melebihi timeout."
//
// Menguji paritas logika firmware (security/security_state.h) dengan
// Correctness Properties 13, 14, 17 referensi JS (src/services/securityState.js).
//
// Property-coverage didekati dengan loop generatif berseed tetap + kasus batas.
//
// _Requirements: 13.1, 13.2, 17.4_
// ============================================================================

#include <unity.h>

#include <cstdint>
#include <vector>

#include "security_state.h"

using namespace smartdoor::security;

// Deterministic xorshift32 PRNG.
static uint32_t g_rng = 0x3C3C9A9Au;
static uint32_t nextRand() {
  uint32_t x = g_rng;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  g_rng = x;
  return x;
}
static void seedRand(uint32_t s) { g_rng = s ? s : 0x0BADF00Du; }

// ===========================================================================
// Property 13 — Brute-force: event pada > 3 tap tak dikenal berturut-turut.
// ===========================================================================

static void test_prop13_fires_only_above_threshold(void) {
  // Empat tap tak dikenal berturut-turut: event dipicu tepat pada tap ke-4.
  BruteForceState st;  // consecutiveUnknown = 0
  BruteForceResult r;

  r = bruteForceOnTap(st, false);  // count=1
  TEST_ASSERT_EQUAL_UINT32(1, r.count);
  TEST_ASSERT_FALSE(r.eventFired);
  st = r.state;

  r = bruteForceOnTap(st, false);  // count=2
  TEST_ASSERT_FALSE(r.eventFired);
  st = r.state;

  r = bruteForceOnTap(st, false);  // count=3 (== threshold) -> belum
  TEST_ASSERT_EQUAL_UINT32(3, r.count);
  TEST_ASSERT_FALSE_MESSAGE(r.eventFired, "threshold eksklusif: 3 belum memicu");
  st = r.state;

  r = bruteForceOnTap(st, false);  // count=4 (> threshold) -> picu
  TEST_ASSERT_EQUAL_UINT32(4, r.count);
  TEST_ASSERT_TRUE_MESSAGE(r.eventFired, "tap ke-4 harus memicu brute-force");
  st = r.state;

  // Setiap tap tak dikenal berikutnya tetap memicu.
  r = bruteForceOnTap(st, false);  // count=5
  TEST_ASSERT_TRUE(r.eventFired);
}

static void test_prop13_known_tap_resets(void) {
  BruteForceState st;
  // 3 tap tak dikenal.
  for (int i = 0; i < 3; ++i) st = bruteForceOnTap(st, false).state;
  TEST_ASSERT_EQUAL_UINT32(3, st.consecutiveUnknown);

  // Tap dikenal mereset ke 0, tanpa event.
  BruteForceResult known = bruteForceOnTap(st, true);
  TEST_ASSERT_EQUAL_UINT32(0, known.count);
  TEST_ASSERT_FALSE(known.eventFired);
  st = known.state;

  // Setelah reset, butuh 4 tap tak dikenal lagi untuk memicu.
  for (int i = 0; i < 3; ++i) {
    BruteForceResult r = bruteForceOnTap(st, false);
    TEST_ASSERT_FALSE(r.eventFired);
    st = r.state;
  }
  BruteForceResult fourth = bruteForceOnTap(st, false);
  TEST_ASSERT_TRUE(fourth.eventFired);
}

// Property 13 — generatif: untuk urutan tap acak, event dipicu IFF penghitung
// berjalan (reset oleh tap dikenal) > 3. Bandingkan dengan oracle.
static void test_prop13_generative_matches_oracle(void) {
  seedRand(0xBF13BF13u);

  for (int iter = 0; iter < 1000; ++iter) {
    BruteForceState st;
    uint32_t oracleConsec = 0;
    int len = static_cast<int>(nextRand() % 40);  // 0..39 tap

    for (int i = 0; i < len; ++i) {
      bool isKnown = (nextRand() % 5) == 0;  // ~20% dikenal
      // Oracle update.
      if (isKnown) {
        oracleConsec = 0;
      } else {
        oracleConsec += 1;
      }
      bool oracleFired = (!isKnown) && (oracleConsec > BRUTE_FORCE_THRESHOLD);

      BruteForceResult r = bruteForceOnTap(st, isKnown);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(oracleConsec, r.count,
                                       "penghitung tidak sesuai oracle");
      TEST_ASSERT_EQUAL_MESSAGE(oracleFired, r.eventFired,
                                "pemicuan event tidak sesuai oracle");
      st = r.state;
    }
  }
}

// ===========================================================================
// Property 14 — Tamper: event IFF pintu beralih terbuka tanpa relay aktif.
// ===========================================================================

static void test_prop14_truth_table(void) {
  // Dari kondisi tertutup (default doorOpen=false):
  TamperState closed;  // doorOpen = false

  // tertutup -> terbuka, relay OFF  => tamper
  {
    TamperResult r = tamperOnDoorTransition(closed, /*doorOpen=*/true,
                                            /*relayEngaged=*/false);
    TEST_ASSERT_TRUE_MESSAGE(r.eventFired, "forced open harus memicu tamper");
    TEST_ASSERT_TRUE(r.state.doorOpen);
  }
  // tertutup -> terbuka, relay ON   => TIDAK tamper (unlock sah)
  {
    TamperResult r = tamperOnDoorTransition(closed, true, true);
    TEST_ASSERT_FALSE_MESSAGE(r.eventFired, "unlock sah tak boleh tamper");
  }
  // tertutup -> tertutup            => tidak ada event
  {
    TamperResult r = tamperOnDoorTransition(closed, false, false);
    TEST_ASSERT_FALSE(r.eventFired);
  }

  // Dari kondisi sudah terbuka:
  TamperState open;
  open.doorOpen = true;
  // terbuka -> terbuka (bukan transisi) => tidak ada event, apa pun relay.
  {
    TamperResult r = tamperOnDoorTransition(open, true, false);
    TEST_ASSERT_FALSE_MESSAGE(r.eventFired,
                              "pintu yang sudah terbuka bukan transisi baru");
  }
  // terbuka -> tertutup => tidak ada event.
  {
    TamperResult r = tamperOnDoorTransition(open, false, false);
    TEST_ASSERT_FALSE(r.eventFired);
    TEST_ASSERT_FALSE(r.state.doorOpen);
  }
}

// Property 14 — generatif: event IFF (openedNow && !relay) untuk transisi acak.
static void test_prop14_generative_matches_oracle(void) {
  seedRand(0x7A3B7A3Bu);

  for (int iter = 0; iter < 2000; ++iter) {
    bool prevOpen = (nextRand() & 1) != 0;
    bool doorOpen = (nextRand() & 1) != 0;
    bool relay = (nextRand() & 1) != 0;

    TamperState st;
    st.doorOpen = prevOpen;

    bool openedNow = doorOpen && !prevOpen;
    bool oracleFired = openedNow && !relay;

    TamperResult r = tamperOnDoorTransition(st, doorOpen, relay);
    TEST_ASSERT_EQUAL_MESSAGE(oracleFired, r.eventFired,
                              "tamper tidak sesuai oracle");
    TEST_ASSERT_EQUAL(doorOpen, r.state.doorOpen);
  }
}

// ===========================================================================
// Property 17 — Door-ajar: alarm IFF durasi terbuka > timeout.
// ===========================================================================

static void test_prop17_boundary(void) {
  // durasi < timeout -> tidak alarm
  TEST_ASSERT_FALSE(doorAjarIsAlarm(999, 1000));
  // durasi == timeout -> batas eksklusif, tidak alarm
  TEST_ASSERT_FALSE_MESSAGE(doorAjarIsAlarm(1000, 1000),
                            "durasi tepat = timeout belum alarm (eksklusif)");
  // durasi > timeout -> alarm
  TEST_ASSERT_TRUE(doorAjarIsAlarm(1001, 1000));
  // timeout 0: durasi apa pun > 0 memicu; durasi 0 tidak.
  TEST_ASSERT_FALSE(doorAjarIsAlarm(0, 0));
  TEST_ASSERT_TRUE(doorAjarIsAlarm(1, 0));
}

static void test_prop17_generative_matches_oracle(void) {
  seedRand(0x17171717u);

  for (int iter = 0; iter < 5000; ++iter) {
    uint32_t timeout = nextRand() % 100000;
    // Pilih durasi di sekitar timeout agar batas tercakup rapat.
    int64_t jitter = static_cast<int64_t>(nextRand() % 5) - 2;  // -2..+2
    int64_t d = static_cast<int64_t>(timeout) + jitter;
    if (d < 0) d = 0;
    uint32_t duration = static_cast<uint32_t>(d);

    bool oracle = duration > timeout;
    TEST_ASSERT_EQUAL_MESSAGE(oracle, doorAjarIsAlarm(duration, timeout),
                              "alarm door-ajar tidak sesuai oracle");
  }
}

// ---------------------------------------------------------------------------
// Unity runner.
// ---------------------------------------------------------------------------
void setUp(void) {}
void tearDown(void) {}

static int runAll(void) {
  UNITY_BEGIN();
  // Property 13
  RUN_TEST(test_prop13_fires_only_above_threshold);
  RUN_TEST(test_prop13_known_tap_resets);
  RUN_TEST(test_prop13_generative_matches_oracle);
  // Property 14
  RUN_TEST(test_prop14_truth_table);
  RUN_TEST(test_prop14_generative_matches_oracle);
  // Property 17
  RUN_TEST(test_prop17_boundary);
  RUN_TEST(test_prop17_generative_matches_oracle);
  return UNITY_END();
}

#ifdef ARDUINO
#include <Arduino.h>
void setup() { runAll(); }
void loop() {}
#else
int main(void) { return runAll(); }
#endif
