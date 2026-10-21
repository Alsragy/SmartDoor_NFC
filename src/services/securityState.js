'use strict';

/**
 * State machine deteksi Brute-Force & Tamper + logika alarm Door-Ajar —
 * Smart Door KOS ESP32.
 *
 * Modul LOGIKA MURNI (tanpa I/O, tanpa jaringan, tanpa relay/reed fisik,
 * tanpa waktu sistem). Semua transisi bersifat *immutable*: fungsi menerima
 * state lama + input dan mengembalikan `{ state, event }` dengan state BARU
 * (input tidak dimutasi). `event` berisi payload bila sebuah kejadian dipicu,
 * atau `null` bila tidak. Dengan begitu modul deterministik & mudah diuji
 * property-based, sekaligus menjadi referensi portabel bagi lapisan firmware
 * (port C++ pada Task 22.3, `nfcReadTask`/`doorControlTask`).
 *
 * Mengikuti design.md "Deteksi Tamper & Brute-Force (Req 13)":
 *   - Brute-force: penghitung tap kartu tak dikenal berturut-turut; tap yang
 *     dikenal mereset ke 0; saat penghitung **> 3** picu event `brute_force`.
 *   - Tamper: pintu beralih ke *open* sementara relay TIDAK diaktifkan →
 *     picu event `tamper` (forced open tanpa instruksi relay).
 *   - Door-ajar: alarm aktif iff durasi pintu terbuka MELEBIHI timeout.
 *
 * Properti terkait (design.md):
 *   - Property 13: event brute-force dipicu tepat ketika >3 tap tak dikenal
 *     berturut-turut; tap dikenal mereset penghitung.
 *   - Property 14: event tamper dipicu iff pintu terbuka sementara relay tidak
 *     diaktifkan pada jendela waktu tersebut.
 *   - Property 17: alarm door-ajar aktif iff durasi terbuka melebihi timeout.
 *
 * _Requirements: 13.1, 13.2, 17.4_
 */

/** Ambang brute-force: event dipicu saat penghitung MELEBIHI nilai ini. */
const BRUTE_FORCE_THRESHOLD = 3;

/* ------------------------------------------------------------------------- *
 * Brute-force (Req 13.1 / Property 13)
 * ------------------------------------------------------------------------- */

/**
 * State awal detektor brute-force.
 * @returns {{ consecutiveUnknown: number }} penghitung tap tak dikenal = 0.
 */
function bruteForceInitialState() {
  return { consecutiveUnknown: 0 };
}

/**
 * Proses satu tap kartu untuk deteksi brute-force.
 *
 * Aturan (design.md): penghitung tap kartu TAK dikenal berturut-turut; tap
 * kartu yang DIKENAL mereset penghitung ke 0. Event `brute_force` dipicu TEPAT
 * saat penghitung melampaui ambang (`> 3`) — yakni pada tap tak dikenal ke-4
 * dan setiap tap tak dikenal berikutnya selama belum ada tap dikenal yang
 * mereset. Payload menyertakan `count` agar konsisten dengan topik MQTT
 * `event/bruteforce { count, ts, api_key }`.
 *
 * Transisi murni: tidak memutasi `state`; mengembalikan state baru.
 *
 * @param {{ consecutiveUnknown: number }} state state sebelumnya.
 * @param {boolean} isKnown true bila tap berasal dari kartu yang dikenal.
 * @returns {{ state: { consecutiveUnknown: number },
 *             event: { type: 'brute_force', count: number }|null }}
 */
function bruteForceOnTap(state, isKnown) {
  const prev =
    state && typeof state.consecutiveUnknown === 'number'
      ? state.consecutiveUnknown
      : 0;

  if (isKnown === true) {
    // Tap dikenal → reset penghitung, tidak ada event.
    return { state: { consecutiveUnknown: 0 }, event: null };
  }

  const count = prev + 1;
  const nextState = { consecutiveUnknown: count };
  const event =
    count > BRUTE_FORCE_THRESHOLD ? { type: 'brute_force', count } : null;
  return { state: nextState, event };
}

/* ------------------------------------------------------------------------- *
 * Tamper (Req 13.2 / Property 14)
 * ------------------------------------------------------------------------- */

/**
 * State awal detektor tamper.
 * Menyimpan status pintu sebelumnya agar transisi (tertutup → terbuka) dapat
 * dideteksi. Diasumsikan pintu mulai dalam keadaan tertutup.
 * @returns {{ doorOpen: boolean }}
 */
function tamperInitialState() {
  return { doorOpen: false };
}

/**
 * Proses transisi status pintu untuk deteksi tamper.
 *
 * Aturan (design.md / Req 13.2): event `tamper` dipicu JIKA DAN HANYA JIKA
 * pintu BERALIH ke keadaan terbuka (tertutup → terbuka) sementara relay TIDAK
 * diaktifkan pada jendela waktu tersebut — mengindikasikan pembukaan paksa
 * tanpa instruksi relay. Pintu yang terbuka karena relay aktif (unlock sah),
 * atau yang memang sudah terbuka sejak sebelumnya, tidak memicu event.
 *
 * Transisi murni: tidak memutasi `state`; mengembalikan state baru dengan
 * status pintu terkini.
 *
 * @param {{ doorOpen: boolean }} state state sebelumnya (status pintu lampau).
 * @param {boolean} doorOpen true bila pintu kini terbuka (reed switch).
 * @param {boolean} relayEngaged true bila relay diaktifkan (unlock sah).
 * @returns {{ state: { doorOpen: boolean }, event: { type: 'tamper' }|null }}
 */
function tamperOnDoorTransition(state, doorOpen, relayEngaged) {
  const wasOpen = !!(state && state.doorOpen);
  const nowOpen = doorOpen === true;
  const engaged = relayEngaged === true;

  const openedNow = nowOpen && !wasOpen; // transisi tertutup → terbuka
  const event = openedNow && !engaged ? { type: 'tamper' } : null;

  return { state: { doorOpen: nowOpen }, event };
}

/* ------------------------------------------------------------------------- *
 * Door-ajar (Req 17.4 / Property 17)
 * ------------------------------------------------------------------------- */

/**
 * Tentukan apakah alarm door-ajar harus aktif.
 *
 * Fungsi murni (tanpa state). Alarm aktif JIKA DAN HANYA JIKA durasi pintu
 * terbuka MELEBIHI timeout (`openDurationMs > timeoutMs`). Pada saat durasi
 * tepat sama dengan timeout, alarm BELUM aktif (batas eksklusif), sesuai
 * Property 17 ("melebihi timeout") & Req 17.4 ("terbuka melebihi Door_Ajar_Timeout").
 *
 * @param {number} openDurationMs lama pintu terbuka (ms).
 * @param {number} timeoutMs batas Door_Ajar_Timeout (ms).
 * @returns {boolean} true iff `openDurationMs > timeoutMs`.
 */
function doorAjarIsAlarm(openDurationMs, timeoutMs) {
  return (
    typeof openDurationMs === 'number' &&
    typeof timeoutMs === 'number' &&
    openDurationMs > timeoutMs
  );
}

module.exports = {
  BRUTE_FORCE_THRESHOLD,
  bruteForce: {
    initialState: bruteForceInitialState,
    onTap: bruteForceOnTap,
  },
  tamper: {
    initialState: tamperInitialState,
    onDoorTransition: tamperOnDoorTransition,
  },
  doorAjar: {
    isAlarm: doorAjarIsAlarm,
  },
};
