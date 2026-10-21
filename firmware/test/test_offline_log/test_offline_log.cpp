// ============================================================================
// test_offline_log.cpp — Host (native) Unity test suite.
//
// Feature: smart-door-kos-esp32
//   Property 8: Round-trip serialisasi log offline.
//     "Untuk sembarang kejadian akses, menserialkan log ke satu baris JSONL
//      lalu mem-parse-nya kembali menghasilkan log yang setara, dan panjang
//      antrean bertambah tepat satu."
//   Property 9: Pengosongan antrean hanya untuk entri ber-ACK.
//     "Untuk sembarang antrean offline dan sembarang subset id yang di-ACK
//      server, antrean setelah pembersihan sama dengan antrean awal dikurangi
//      tepat entri yang id-nya di-ACK."
//
// Menguji paritas logika firmware (offline_log/offline_log.{h,cpp}) dengan
// Correctness Properties 8 & 9 referensi JS (src/services/offlineLog.js).
//
// Property-coverage didekati dengan loop generatif berseed tetap + kasus batas.
//
// _Requirements: 6.3_
// ============================================================================

#include <unity.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

#include "offline_log.h"

using namespace smartdoor::offline_log;

// Deterministic xorshift32 PRNG.
static uint32_t g_rng = 0x8F3A1C77u;
static uint32_t nextRand() {
  uint32_t x = g_rng;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  g_rng = x;
  return x;
}
static void seedRand(uint32_t s) { g_rng = s ? s : 0xFEEDFACEu; }

// Buat UID heksadesimal acak panjang bervariasi.
static std::string randUid() {
  static const char* hex = "0123456789ABCDEF";
  int len = 8 + static_cast<int>(nextRand() % 8);  // 8..15 nibble
  std::string s;
  for (int i = 0; i < len; ++i) s.push_back(hex[nextRand() & 0xF]);
  return s;
}

static LogEvent randEvent(uint32_t seqForId) {
  LogEvent e;
  e.id = std::string("dev01-") + std::to_string(100000 + seqForId);
  e.ts = "2025-06-18T09:12:03Z";
  e.uid = randUid();
  e.result = (nextRand() & 1) ? "GRANT" : "DENY";
  e.sync_type = "CACHED_OFFLINE";
  if (nextRand() & 1) {
    e.has_ts_unverified = true;
    e.ts_unverified = (nextRand() & 1) ? 1 : 0;
  }
  return e;
}

static void assertEventEqual(const LogEvent& a, const LogEvent& b) {
  TEST_ASSERT_EQUAL_STRING(a.id.c_str(), b.id.c_str());
  TEST_ASSERT_EQUAL_STRING(a.ts.c_str(), b.ts.c_str());
  TEST_ASSERT_EQUAL_STRING(a.uid.c_str(), b.uid.c_str());
  TEST_ASSERT_EQUAL_STRING(a.result.c_str(), b.result.c_str());
  TEST_ASSERT_EQUAL_STRING(a.sync_type.c_str(), b.sync_type.c_str());
  TEST_ASSERT_EQUAL(a.has_ts_unverified, b.has_ts_unverified);
  if (a.has_ts_unverified) {
    TEST_ASSERT_EQUAL_INT(a.ts_unverified, b.ts_unverified);
  }
}

// ===========================================================================
// Property 8 — Round-trip serialisasi.
// ===========================================================================

static void test_prop8_roundtrip_and_queue_grows_by_one(void) {
  seedRand(0x8888AAAAu);

  std::vector<LogEvent> queue;  // antrean yang tumbuh
  for (uint32_t iter = 0; iter < 3000; ++iter) {
    LogEvent original = randEvent(iter);

    // Serialisasi -> satu baris JSONL (tanpa newline).
    std::string line;
    TEST_ASSERT_TRUE_MESSAGE(serialize(original, line),
                             "serialize gagal / mengandung newline");
    TEST_ASSERT_EQUAL_MESSAGE(std::string::npos, line.find('\n'),
                              "baris JSONL tidak boleh memuat newline");
    TEST_ASSERT_EQUAL(std::string::npos, line.find('\r'));

    // Parse kembali -> event setara.
    LogEvent parsed;
    TEST_ASSERT_TRUE_MESSAGE(parse(line, parsed), "parse gagal");
    assertEventEqual(original, parsed);

    // Panjang antrean bertambah tepat satu saat event diantrekan.
    size_t before = queue.size();
    queue.push_back(parsed);
    TEST_ASSERT_EQUAL_UINT32(before + 1, queue.size());
  }
}

// Property 8 — kasus batas: field kosong & ts_unverified absen vs. 0.
static void test_prop8_boundary_empty_and_optional(void) {
  // (a) semua field inti kosong, ts_unverified absen.
  LogEvent e;  // default: semua string kosong, has_ts_unverified=false
  std::string line = serialize(e);
  TEST_ASSERT_FALSE(line.empty());
  LogEvent parsed;
  TEST_ASSERT_TRUE(parse(line, parsed));
  assertEventEqual(e, parsed);
  TEST_ASSERT_FALSE(parsed.has_ts_unverified);

  // (b) ts_unverified = 0 eksplisit harus round-trip sebagai diset = 0.
  LogEvent e2;
  e2.id = "dev01-000001";
  e2.has_ts_unverified = true;
  e2.ts_unverified = 0;
  std::string line2 = serialize(e2);
  LogEvent parsed2;
  TEST_ASSERT_TRUE(parse(line2, parsed2));
  TEST_ASSERT_TRUE(parsed2.has_ts_unverified);
  TEST_ASSERT_EQUAL_INT(0, parsed2.ts_unverified);

  // (c) baris non-objek JSON ditolak.
  LogEvent junk;
  TEST_ASSERT_FALSE(parse("[1,2,3]", junk));
  TEST_ASSERT_FALSE(parse("not json", junk));
}

// ===========================================================================
// Property 9 — Pruning hanya untuk entri ber-ACK.
// ===========================================================================

static void test_prop9_prune_removes_exactly_acked(void) {
  seedRand(0x99995555u);

  for (int iter = 0; iter < 500; ++iter) {
    int n = static_cast<int>(nextRand() % 20);  // 0..19 entri
    std::vector<LogEvent> queue;
    for (int i = 0; i < n; ++i) {
      LogEvent e = randEvent(static_cast<uint32_t>(iter * 100 + i));
      // id unik per entri di antrean (deterministik).
      e.id = std::string("dev01-") + std::to_string(iter * 1000 + i);
      queue.push_back(e);
    }

    // Pilih subset acak id untuk di-ACK.
    std::vector<std::string> acked;
    for (const auto& e : queue) {
      if (nextRand() & 1) acked.push_back(e.id);
    }

    std::vector<LogEvent> pruned = pruneAcked(queue, acked);

    // Oracle: hasil = queue tanpa entri yang id-nya di himpunan acked.
    std::vector<LogEvent> expected;
    for (const auto& e : queue) {
      bool isAcked = std::find(acked.begin(), acked.end(), e.id) != acked.end();
      if (!isAcked) expected.push_back(e);
    }

    TEST_ASSERT_EQUAL_UINT32_MESSAGE(expected.size(), pruned.size(),
                                     "ukuran antrean hasil prune salah");
    // Urutan dipertahankan & isi sama.
    for (size_t i = 0; i < expected.size(); ++i) {
      assertEventEqual(expected[i], pruned[i]);
    }

    // Tidak ada entri ber-ACK yang tersisa.
    for (const auto& e : pruned) {
      bool stillAcked =
          std::find(acked.begin(), acked.end(), e.id) != acked.end();
      TEST_ASSERT_FALSE_MESSAGE(stillAcked, "entri ber-ACK tidak terhapus");
    }
  }
}

// Property 9 — kasus batas: ACK kosong (antrean utuh) & entri tanpa id
// (selalu dipertahankan, tak mungkin ber-ACK).
static void test_prop9_boundary_empty_ack_and_no_id(void) {
  std::vector<LogEvent> queue;
  LogEvent a;
  a.id = "dev01-1";
  LogEvent noId;  // id kosong
  noId.uid = "AABBCC";
  queue.push_back(a);
  queue.push_back(noId);

  // ACK kosong -> antrean identik (salinan).
  std::vector<LogEvent> same = pruneAcked(queue, {});
  TEST_ASSERT_EQUAL_UINT32(queue.size(), same.size());

  // ACK "dev01-1" -> hanya a terhapus; noId (tanpa id) dipertahankan.
  std::vector<LogEvent> pruned = pruneAcked(queue, {"dev01-1"});
  TEST_ASSERT_EQUAL_UINT32(1, pruned.size());
  TEST_ASSERT_EQUAL_STRING("", pruned[0].id.c_str());
  TEST_ASSERT_EQUAL_STRING("AABBCC", pruned[0].uid.c_str());

  // ACK id yang tak ada -> tak mengubah apa pun.
  std::vector<LogEvent> unchanged = pruneAcked(queue, {"dev99-999"});
  TEST_ASSERT_EQUAL_UINT32(queue.size(), unchanged.size());
}

// ---------------------------------------------------------------------------
// Unity runner.
// ---------------------------------------------------------------------------
void setUp(void) {}
void tearDown(void) {}

static int runAll(void) {
  UNITY_BEGIN();
  RUN_TEST(test_prop8_roundtrip_and_queue_grows_by_one);
  RUN_TEST(test_prop8_boundary_empty_and_optional);
  RUN_TEST(test_prop9_prune_removes_exactly_acked);
  RUN_TEST(test_prop9_boundary_empty_ack_and_no_id);
  return UNITY_END();
}

#ifdef ARDUINO
#include <Arduino.h>
void setup() { runAll(); }
void loop() {}
#else
int main(void) { return runAll(); }
#endif
