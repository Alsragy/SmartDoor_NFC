// ============================================================================
// access_decision.h — Logika keputusan akses portabel (port C++ dari
// src/services/accessDecision.js) — Smart Door KOS ESP32.
//
// Modul MURNI (header-only, tanpa efek samping): tidak menyentuh I/O, jaringan,
// relay, radio, GPIO, maupun waktu sistem. Semua input (kartu, waktu `now`,
// validitas kripto) diberikan secara eksplisit sebagai argumen agar
// deterministik & dapat diuji di host (property-based, Task 22.4).
//
// TIDAK ADA #include <Arduino.h> di sini — modul ini dikompilasi sama persis
// untuk [env:esp32dev] dan [env:native]. Hanya header C++17 standar.
//
// Paritas dengan referensi JS (src/services/accessDecision.js):
//   - effectiveStatus(card, now) -> SUSPENDED iff now >= expired_at;
//     selain itu status tersimpan kartu (ACTIVE/SUSPENDED/REVOKED/
//     UNPROVISIONED).
//   - decide(cryptoValid, card, now) -> GRANT iff cryptoValid == true AND
//     status efektif ACTIVE AND belum kedaluwarsa; selain itu DENY.
//
// Properti terkait (design.md "Alur Keputusan Offline-First"):
//   - Property 4: GRANT tepat saat tidak Suspended & belum kedaluwarsa, bahkan
//     offline; selain itu DENY (whitelist lokal → tetap berlaku offline).
//   - Property 5: status efektif SUSPENDED iff now >= expired_at.
//
// _Requirements: 1.1, 1.5, 3.4, 4.2, 9.3_
// ============================================================================

#ifndef SMARTDOOR_DECISION_ACCESS_DECISION_H
#define SMARTDOOR_DECISION_ACCESS_DECISION_H

#include <cstdint>

namespace smartdoor {
namespace decision {

// ---------------------------------------------------------------------------
// Status kartu NFC — setara CARD_STATUS di src/constants.js.
//   ACTIVE        — kartu valid & aktif, dapat GRANT.
//   SUSPENDED     — ditangguhkan (mis. billing-lock: now >= expired_at).
//   REVOKED       — dicabut permanen; biasanya dihapus dari whitelist (Req 10).
//   UNPROVISIONED — provisioning belum selesai / gagal.
// ---------------------------------------------------------------------------
enum class CardStatus : uint8_t {
  UNPROVISIONED = 0,
  ACTIVE = 1,
  SUSPENDED = 2,
  REVOKED = 3,
};

// ---------------------------------------------------------------------------
// Hasil keputusan akses — setara DECISION di accessDecision.js.
// Modul ini HANYA mengembalikan GRANT/DENY; aktuasi relay fisik ditangani
// lapisan firmware di atasnya (Req 1.5, Req 3.5).
// ---------------------------------------------------------------------------
enum class Decision : uint8_t {
  DENY = 0,
  GRANT = 1,
};

// ---------------------------------------------------------------------------
// Alasan keputusan — stabil & dapat dipetakan ke log akses.
// Paralel dengan string `reason` pada accessDecision.js.
// ---------------------------------------------------------------------------
enum class DenyReason : uint8_t {
  OK = 0,              // (dipakai saat GRANT)
  UNKNOWN_CARD = 1,    // kartu null / tidak ada di whitelist
  CRYPTO_INVALID = 2,  // verifikasi kripto gagal (Req 1.5)
  EXPIRED = 3,         // now >= expired_at (Req 9.2)
  STATUS_SUSPENDED = 4,
  STATUS_REVOKED = 5,
  STATUS_UNPROVISIONED = 6,
};

// ---------------------------------------------------------------------------
// Representasi entri kartu untuk keputusan — subset dari whitelist.json yang
// relevan bagi logika GRANT/DENY. Waktu direpresentasikan sebagai epoch
// milidetik (int64) agar portabel & deterministik; nilai `expired_at`
// opsional direpresentasikan dengan flag `has_expiry` (padanan null/''/absen
// di JS → tanpa masa berlaku).
//
// `valid == false` menandakan "tidak ada kartu" (padanan card null/undefined
// di JS), menghasilkan DENY(UNKNOWN_CARD).
// ---------------------------------------------------------------------------
struct Card {
  bool valid = false;                              // true jika entri kartu ada
  CardStatus status = CardStatus::UNPROVISIONED;   // status tersimpan
  bool has_expiry = false;                         // apakah expired_at ada
  int64_t expired_at_ms = 0;                       // epoch ms (valid iff has_expiry)

  // Konstruktor praktis untuk firmware & test.
  static Card none() { return Card{}; }

  static Card withStatus(CardStatus s) {
    Card c;
    c.valid = true;
    c.status = s;
    c.has_expiry = false;
    return c;
  }

  static Card withExpiry(CardStatus s, int64_t expiredAtMs) {
    Card c;
    c.valid = true;
    c.status = s;
    c.has_expiry = true;
    c.expired_at_ms = expiredAtMs;
    return c;
  }
};

// Hasil keputusan stabil { result, reason } — setara objek { result, reason }
// yang dikembalikan decide() di JS.
struct Outcome {
  Decision result = Decision::DENY;
  DenyReason reason = DenyReason::UNKNOWN_CARD;

  bool granted() const { return result == Decision::GRANT; }
};

// ---------------------------------------------------------------------------
// isExpired(card, now) — true iff kartu punya masa berlaku DAN now >= expired_at.
// Kartu tanpa masa berlaku (has_expiry == false) tidak pernah kedaluwarsa.
// (Paritas: isExpired di accessDecision.js, Req 9.2.)
// ---------------------------------------------------------------------------
inline bool isExpired(const Card& card, int64_t nowMs) {
  if (!card.valid || !card.has_expiry) {
    return false;
  }
  return nowMs >= card.expired_at_ms;
}

// ---------------------------------------------------------------------------
// effectiveStatus(card, now) — status efektif pada waktu `now`.
// Kartu kedaluwarsa (now >= expired_at) diperlakukan SUSPENDED secara efektif
// meski status tersimpan masih ACTIVE (billing-lock, Req 9.2). Selain itu
// kembalikan status tersimpan; kartu tak valid → UNPROVISIONED.
// (Paritas: effectiveStatus di accessDecision.js, Property 5.)
// ---------------------------------------------------------------------------
inline CardStatus effectiveStatus(const Card& card, int64_t nowMs) {
  if (isExpired(card, nowMs)) {
    return CardStatus::SUSPENDED;
  }
  if (!card.valid) {
    return CardStatus::UNPROVISIONED;
  }
  return card.status;
}

// Konversi status efektif non-grantable → alasan DENY yang sesuai.
inline DenyReason statusDenyReason(CardStatus status) {
  switch (status) {
    case CardStatus::SUSPENDED:
      return DenyReason::STATUS_SUSPENDED;
    case CardStatus::REVOKED:
      return DenyReason::STATUS_REVOKED;
    case CardStatus::UNPROVISIONED:
      return DenyReason::STATUS_UNPROVISIONED;
    case CardStatus::ACTIVE:
    default:
      return DenyReason::OK;  // grantable; tidak dipakai sebagai DENY
  }
}

// ---------------------------------------------------------------------------
// decide(cryptoValid, card, now) — keputusan akses offline-first.
//
// GRANT iff SEMUA benar (urutan evaluasi mengikuti referensi JS):
//   - card.valid == true (bukan UNKNOWN_CARD), DAN
//   - cryptoValid == true (verifikasi kripto lolos, Req 1.1/1.5), DAN
//   - belum kedaluwarsa now < expired_at (Req 9.2), DAN
//   - status efektif ACTIVE — bukan SUSPENDED/REVOKED/UNPROVISIONED (Req 9.3).
// Selain itu DENY. Murni berbasis whitelist lokal → tetap berlaku offline
// (Req 3.4, 4.2).
//
// `cryptoValid` adalah input eksplisit agar modul tetap murni & dapat diuji
// tanpa menjalankan verifikasi kripto sesungguhnya (lihat crypto_verify.h).
// ---------------------------------------------------------------------------
inline Outcome decide(bool cryptoValid, const Card& card, int64_t nowMs) {
  Outcome out;

  if (!card.valid) {
    out.result = Decision::DENY;
    out.reason = DenyReason::UNKNOWN_CARD;
    return out;
  }

  if (cryptoValid != true) {
    out.result = Decision::DENY;
    out.reason = DenyReason::CRYPTO_INVALID;
    return out;
  }

  if (isExpired(card, nowMs)) {
    out.result = Decision::DENY;
    out.reason = DenyReason::EXPIRED;
    return out;
  }

  const CardStatus status = effectiveStatus(card, nowMs);
  if (status != CardStatus::ACTIVE) {
    out.result = Decision::DENY;
    out.reason = statusDenyReason(status);
    return out;
  }

  out.result = Decision::GRANT;
  out.reason = DenyReason::OK;
  return out;
}

}  // namespace decision
}  // namespace smartdoor

#endif  // SMARTDOOR_DECISION_ACCESS_DECISION_H
