// ============================================================================
// test_whitelist_delta.cpp — Host (native) Unity test suite.
//
// Feature: smart-door-kos-esp32
//   Property 6: Pencabutan menghapus akses tepat sasaran.
//     "Untuk sembarang whitelist, setelah entri sebuah UID dihapus, verifikasi
//      UID tersebut menghasilkan DENY, sedangkan keputusan untuk semua UID lain
//      tidak berubah."
//   Property 7: Delta sync merekonstruksi state server.
//     "Untuk sembarang pasangan snapshot whitelist lokal dan server, menerapkan
//      delta (changed + removed) berbasis versi ke snapshot lokal menghasilkan
//      state yang db_hash-nya identik dengan snapshot server."
//
// Menguji paritas logika firmware (whitelist/whitelist_delta.{h,cpp} +
// sha256.h) dengan Correctness Properties 6 & 7 referensi JS
// (src/services/whitelistVersion.js). SHA-256 referensi portabel memungkinkan
// db_hash dihitung penuh di host.
//
// Property-coverage didekati dengan loop generatif berseed tetap + kasus batas.
//
// _Requirements: 4.3_
// ============================================================================

#include <unity.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

#include "whitelist_delta.h"

using namespace smartdoor::whitelist;

// Deterministic xorshift32 PRNG.
static uint32_t g_rng = 0x51A7E3C9u;
static uint32_t nextRand() {
  uint32_t x = g_rng;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  g_rng = x;
  return x;
}
static void seedRand(uint32_t s) { g_rng = s ? s : 0xBADC0DE1u; }

static std::string makeUid(uint32_t i) {
  static const char* hex = "0123456789ABCDEF";
  std::string s = "04";
  for (int k = 0; k < 4; ++k) {
    s.push_back(hex[(i >> (k * 4)) & 0xF]);
  }
  return s;
}

static Card makeCard(const std::string& uid, const char* status) {
  Card c;
  c.uid = uid;
  c.key_version = "v1";
  c.status = status;
  c.expired_at = "";
  c.db_version = 1;
  return c;
}

// Oracle "server db_hash": bangun snapshot server langsung dari himpunan kartu
// aktif, independen dari applyDelta. Property 7 menuntut applyDelta
// menghasilkan db_hash yang sama.
static std::string serverDbHash(const std::vector<Card>& allCards) {
  return dbHash(activeCards(allCards));
}

// ===========================================================================
// Property 6 — Pencabutan menghapus akses tepat sasaran.
// ===========================================================================

static void test_prop6_revoke_removes_exact_target(void) {
  seedRand(0x11111111u);

  for (int iter = 0; iter < 400; ++iter) {
    int n = 2 + static_cast<int>(nextRand() % 8);  // 2..9 kartu aktif

    Snapshot local;
    local.db_version = 1;
    std::vector<std::string> uids;
    for (int i = 0; i < n; ++i) {
      std::string uid = makeUid(static_cast<uint32_t>(iter * 100 + i));
      uids.push_back(uid);
      local.cards.push_back(makeCard(uid, status::kActive()));
    }
    local.db_hash = dbHash(activeCards(local.cards));

    // Pilih satu target untuk dicabut.
    size_t targetIdx = nextRand() % uids.size();
    std::string target = uids[targetIdx];

    Delta delta;
    delta.db_version = 2;
    delta.removed.push_back(target);
    // db_hash server setelah target hilang (dari kartu tersisa).
    std::vector<Card> remaining;
    for (const auto& c : local.cards) {
      if (c.uid != target) remaining.push_back(c);
    }
    delta.db_hash = dbHash(activeCards(remaining));

    Snapshot after = applyDelta(local, delta);

    // (a) Target TIDAK lagi ada di snapshot hasil.
    bool targetPresent = std::any_of(
        after.cards.begin(), after.cards.end(),
        [&](const Card& c) { return c.uid == target; });
    TEST_ASSERT_FALSE_MESSAGE(targetPresent,
                              "UID target masih ada setelah dicabut");

    // (b) SEMUA UID lain tetap ada, tidak berubah.
    for (const auto& uid : uids) {
      if (uid == target) continue;
      bool present = std::any_of(
          after.cards.begin(), after.cards.end(),
          [&](const Card& c) { return c.uid == uid; });
      TEST_ASSERT_TRUE_MESSAGE(present, "UID lain hilang tak sengaja");
    }

    // (c) Jumlah kartu berkurang tepat satu.
    TEST_ASSERT_EQUAL_UINT32(local.cards.size() - 1, after.cards.size());

    // (d) db_hash hasil cocok dengan db_hash server (konsistensi Property 7).
    TEST_ASSERT_EQUAL_STRING(delta.db_hash.c_str(), after.db_hash.c_str());
  }
}

// Property 6 — REVOKED pada changed diperlakukan sebagai penghapusan (isRemoved).
static void test_prop6_changed_revoked_is_removed(void) {
  Snapshot local;
  local.cards.push_back(makeCard(makeUid(1), status::kActive()));
  local.cards.push_back(makeCard(makeUid(2), status::kActive()));
  local.db_hash = dbHash(activeCards(local.cards));

  Delta delta;
  delta.db_version = 2;
  // Tandai uid#1 REVOKED via changed -> harus hilang dari kartu aktif.
  delta.changed.push_back(makeCard(makeUid(1), status::kRevoked()));

  Snapshot after = applyDelta(local, delta);

  // uid#1 tidak boleh muncul sebagai kartu aktif.
  auto act = activeCards(after.cards);
  bool activePresent = std::any_of(
      act.begin(), act.end(),
      [&](const Card& c) { return c.uid == makeUid(1); });
  TEST_ASSERT_FALSE(activePresent);
}

// ===========================================================================
// Property 7 — Delta sync merekonstruksi state server.
// ===========================================================================

static void test_prop7_applydelta_reconstructs_server_hash(void) {
  seedRand(0x7A7A7A7Au);
  const char* statuses[] = {status::kActive(), status::kActive(),
                            status::kActive(), status::kSuspended()};

  for (int iter = 0; iter < 300; ++iter) {
    // --- Snapshot lokal awal: beberapa kartu acak ---
    Snapshot local;
    local.db_version = 1;
    int baseN = 1 + static_cast<int>(nextRand() % 6);
    std::vector<Card> serverCards;  // keadaan server yang ingin direkonstruksi
    for (int i = 0; i < baseN; ++i) {
      std::string uid = makeUid(static_cast<uint32_t>(0x1000 + iter * 50 + i));
      Card c = makeCard(uid, statuses[nextRand() % 4]);
      local.cards.push_back(c);
      serverCards.push_back(c);
    }
    local.db_hash = dbHash(activeCards(local.cards));

    Delta delta;
    delta.db_version = 2;

    // --- changed: upsert beberapa kartu (baru atau ubah status) ---
    int changes = static_cast<int>(nextRand() % 4);
    for (int i = 0; i < changes; ++i) {
      bool modifyExisting = !local.cards.empty() && (nextRand() & 1);
      std::string uid =
          modifyExisting
              ? local.cards[nextRand() % local.cards.size()].uid
              : makeUid(static_cast<uint32_t>(0x9000 + iter * 50 + i));
      Card c = makeCard(uid, statuses[nextRand() % 4]);
      delta.changed.push_back(c);

      // Terapkan perubahan yang sama ke model server (upsert by uid).
      auto it = std::find_if(serverCards.begin(), serverCards.end(),
                             [&](const Card& x) { return x.uid == uid; });
      if (it != serverCards.end()) {
        *it = c;
      } else {
        serverCards.push_back(c);
      }
    }

    // --- removed: cabut sebagian uid ---
    if (!serverCards.empty()) {
      int rem = static_cast<int>(nextRand() % 3);
      for (int i = 0; i < rem && !serverCards.empty(); ++i) {
        size_t ri = nextRand() % serverCards.size();
        std::string uid = serverCards[ri].uid;
        delta.removed.push_back(uid);
        serverCards.erase(
            std::remove_if(serverCards.begin(), serverCards.end(),
                           [&](const Card& x) { return x.uid == uid; }),
            serverCards.end());
      }
    }

    // db_hash referensi server = hash atas kartu aktif server.
    delta.db_hash = serverDbHash(serverCards);

    // --- Terapkan delta & verifikasi rekonstruksi ---
    Snapshot out;
    bool ok = applyDeltaVerified(local, delta, out);

    TEST_ASSERT_EQUAL_STRING_MESSAGE(
        delta.db_hash.c_str(), out.db_hash.c_str(),
        "db_hash hasil applyDelta != db_hash server (Property 7)");
    TEST_ASSERT_TRUE_MESSAGE(ok, "applyDeltaVerified harus konsisten");
    TEST_ASSERT_EQUAL_INT64(delta.db_version, out.db_version);
  }
}

// Property 7 — db_hash tidak bergantung urutan input kartu (determinisme).
static void test_prop7_dbhash_order_independent(void) {
  std::vector<Card> a = {makeCard(makeUid(3), status::kActive()),
                         makeCard(makeUid(1), status::kActive()),
                         makeCard(makeUid(2), status::kActive())};
  std::vector<Card> b = {makeCard(makeUid(1), status::kActive()),
                         makeCard(makeUid(2), status::kActive()),
                         makeCard(makeUid(3), status::kActive())};
  TEST_ASSERT_EQUAL_STRING(dbHash(a).c_str(), dbHash(b).c_str());
}

// Property 7 — db_hash hanya memperhitungkan kartu aktif (REVOKED diabaikan).
static void test_prop7_dbhash_ignores_removed(void) {
  std::vector<Card> withRevoked = {makeCard(makeUid(1), status::kActive()),
                                   makeCard(makeUid(2), status::kRevoked())};
  std::vector<Card> activeOnly = {makeCard(makeUid(1), status::kActive())};
  // dbHash() harus diberi kartu aktif; activeCards() menyaring REVOKED.
  TEST_ASSERT_EQUAL_STRING(dbHash(activeCards(withRevoked)).c_str(),
                           dbHash(activeOnly).c_str());
}

// ---------------------------------------------------------------------------
// Unity runner.
// ---------------------------------------------------------------------------
void setUp(void) {}
void tearDown(void) {}

static int runAll(void) {
  UNITY_BEGIN();
  RUN_TEST(test_prop6_revoke_removes_exact_target);
  RUN_TEST(test_prop6_changed_revoked_is_removed);
  RUN_TEST(test_prop7_applydelta_reconstructs_server_hash);
  RUN_TEST(test_prop7_dbhash_order_independent);
  RUN_TEST(test_prop7_dbhash_ignores_removed);
  return UNITY_END();
}

#ifdef ARDUINO
#include <Arduino.h>
void setup() { runAll(); }
void loop() {}
#else
int main(void) { return runAll(); }
#endif
