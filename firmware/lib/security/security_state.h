// ===========================================================================
// Smart Door KOS ESP32 — Modul logika keamanan portabel (header-only, C++17)
//
// Port C++ MURNI & PORTABEL dari src/services/securityState.js (server JS).
// Tanpa Arduino.h, tanpa GPIO/radio, tanpa jaringan, tanpa waktu sistem —
// sehingga dapat di-property-test di host ([env:native], `pio test -e native`)
// sekaligus dipakai ulang oleh task firmware (nfcReadTask / doorControlTask).
//
// Semua transisi bersifat *immutable* / murni: fungsi menerima state lama +
// input dan mengembalikan struct hasil berisi state BARU + flag event
// (meniru bentuk return `{ state, event }` pada modul JS). State masukan tidak
// dimutasi.
//
// Mengikuti design.md "Deteksi Tamper & Brute-Force (Req 13)":
//   - Brute-force: penghitung tap kartu tak dikenal berturut-turut; tap dikenal
//     mereset ke 0; saat penghitung > 3 picu event brute_force (Property 13).
//   - Tamper: pintu beralih tertutup -> terbuka sementara relay TIDAK aktif
//     memicu event tamper (Property 14).
//   - Door-ajar: alarm aktif iff durasi terbuka MELEBIHI timeout (Property 17).
//
// _Requirements: 13.1, 13.2, 17.4_
// ===========================================================================

#ifndef SMARTDOOR_SECURITY_STATE_H
#define SMARTDOOR_SECURITY_STATE_H

#include <cstdint>

namespace smartdoor {
namespace security {

// ---------------------------------------------------------------------------
// Konstanta
// ---------------------------------------------------------------------------

// Ambang brute-force: event dipicu saat penghitung MELEBIHI nilai ini (> 3),
// yakni pada tap tak dikenal ke-4 dan setiap tap tak dikenal berikutnya selama
// belum ada tap dikenal yang mereset. Mirror BRUTE_FORCE_THRESHOLD di JS.
inline constexpr std::uint32_t BRUTE_FORCE_THRESHOLD = 3;

// ===========================================================================
// Brute-force (Req 13.1 / Property 13)
// ===========================================================================

// State detektor brute-force: penghitung tap kartu tak dikenal berturut-turut.
// Nilai awal (default) = 0, setara bruteForce.initialState() di JS.
struct BruteForceState {
  std::uint32_t consecutiveUnknown = 0;
};

// Hasil transisi onTap: state baru, apakah event dipicu, dan penghitung terkini
// (count disertakan agar konsisten dengan payload MQTT event/bruteforce
// { count, ts, api_key }).
struct BruteForceResult {
  BruteForceState state;        // state baru (immutable terhadap input)
  bool eventFired = false;      // true bila event brute_force dipicu
  std::uint32_t count = 0;      // nilai penghitung setelah transisi
};

// Proses satu tap kartu untuk deteksi brute-force.
//
// Aturan (design.md / JS): tap DIKENAL (isKnown == true) mereset penghitung ke
// 0 tanpa event. Tap TAK dikenal menaikkan penghitung; event dipicu TEPAT saat
// penghitung melampaui ambang (count > BRUTE_FORCE_THRESHOLD).
//
// Transisi murni: `state` tidak dimutasi; hasil berisi state baru.
inline BruteForceResult bruteForceOnTap(const BruteForceState& state,
                                        bool isKnown) {
  BruteForceResult result;

  if (isKnown) {
    // Tap dikenal -> reset penghitung, tidak ada event.
    result.state.consecutiveUnknown = 0;
    result.eventFired = false;
    result.count = 0;
    return result;
  }

  const std::uint32_t count = state.consecutiveUnknown + 1;
  result.state.consecutiveUnknown = count;
  result.count = count;
  result.eventFired = (count > BRUTE_FORCE_THRESHOLD);
  return result;
}

// ===========================================================================
// Tamper (Req 13.2 / Property 14)
// ===========================================================================

// State detektor tamper: menyimpan status pintu sebelumnya agar transisi
// (tertutup -> terbuka) dapat dideteksi. Default: pintu tertutup (false),
// setara tamper.initialState() di JS.
struct TamperState {
  bool doorOpen = false;
};

// Hasil transisi onDoorTransition: state baru + flag event tamper.
struct TamperResult {
  TamperState state;        // state baru dengan status pintu terkini
  bool eventFired = false;  // true bila event tamper dipicu
};

// Proses transisi status pintu untuk deteksi tamper.
//
// Aturan (design.md / Req 13.2): event tamper dipicu JIKA DAN HANYA JIKA pintu
// BERALIH tertutup -> terbuka (openedNow) sementara relay TIDAK diaktifkan
// (relayEngaged == false) pada jendela waktu tersebut — indikasi forced open.
// Pintu yang terbuka karena relay aktif (unlock sah), atau yang memang sudah
// terbuka sebelumnya, tidak memicu event.
//
// Transisi murni: `state` tidak dimutasi; hasil berisi state baru.
inline TamperResult tamperOnDoorTransition(const TamperState& state,
                                           bool doorOpen,
                                           bool relayEngaged) {
  const bool wasOpen = state.doorOpen;
  const bool openedNow = doorOpen && !wasOpen;  // transisi tertutup -> terbuka

  TamperResult result;
  result.state.doorOpen = doorOpen;
  result.eventFired = openedNow && !relayEngaged;
  return result;
}

// ===========================================================================
// Door-ajar (Req 17.4 / Property 17)
// ===========================================================================

// Tentukan apakah alarm door-ajar harus aktif.
//
// Fungsi MURNI (tanpa state). Alarm aktif JIKA DAN HANYA JIKA durasi pintu
// terbuka MELEBIHI timeout (openDurationMs > timeoutMs). Pada durasi tepat sama
// dengan timeout, alarm BELUM aktif (batas eksklusif), sesuai Property 17 &
// Req 17.4.
inline bool doorAjarIsAlarm(std::uint32_t openDurationMs,
                            std::uint32_t timeoutMs) {
  return openDurationMs > timeoutMs;
}

}  // namespace security
}  // namespace smartdoor

#endif  // SMARTDOOR_SECURITY_STATE_H
