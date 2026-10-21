'use strict';

/**
 * Lapisan Verifikasi NFC Kripto — challenge-response AES-128 (RULE A, Req 1).
 *
 * Mengimplementasikan Skema A (DESFire EV2/EV3) dari design.md
 * "Lapisan Verifikasi NFC Kripto":
 *   1. Firmware/reader mengirim nonce acak (challenge) ke kartu.
 *   2. Kartu membalas `response = AES-128(nonce, diversified_key)`.
 *   3. Firmware memverifikasi `AES-128_decrypt(response, diversified_key) == nonce`.
 *
 * Verifikasi bersifat kriptografis dan tidak mengandalkan UID sebagai
 * satu-satunya faktor (Req 1.1). Bila verifikasi gagal, keputusan adalah DENY
 * dan relay tidak digerakkan (Req 1.5) — modul ini hanya menghasilkan keputusan
 * boolean; aktuasi relay ditangani lapisan di atasnya.
 *
 * Modul ini adalah LOGIKA MURNI (hanya `crypto` bawaan Node) sehingga menjadi
 * referensi portabel untuk lapisan keputusan firmware yang dapat diuji di host.
 *
 * Implementasi: AES-128-ECB single-block (16 byte), tanpa padding — meniru
 * enkripsi satu blok pada challenge-response DESFire. Baik nonce maupun kunci
 * berukuran tepat 16 byte (128 bit).
 *
 * _Requirements: 1.1, 1.3, 1.5_
 */

const crypto = require('crypto');

/** Ukuran blok / nonce / kunci AES-128 dalam byte. */
const BLOCK_SIZE = 16;

/** Nama algoritma cipher untuk satu blok AES-128 tanpa padding. */
const CIPHER_ALGO = 'aes-128-ecb';

/**
 * Normalisasi input biner menjadi Buffer berukuran tepat `expectedLen` byte.
 * Menerima Buffer atau string heksadesimal (case-insensitive, boleh berawalan
 * "0x", spasi diabaikan). Melempar bila panjang tidak sesuai atau tipe salah.
 *
 * @param {Buffer|string} value   nilai biner (Buffer atau hex string).
 * @param {number} expectedLen    panjang wajib dalam byte.
 * @param {string} label          nama argumen untuk pesan error.
 * @returns {Buffer} Buffer ter-normalisasi sepanjang `expectedLen`.
 */
function toBuffer(value, expectedLen, label) {
  let buf;
  if (Buffer.isBuffer(value)) {
    buf = value;
  } else if (typeof value === 'string') {
    const hex = value.trim().replace(/^0x/i, '').replace(/\s+/g, '');
    if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
      throw new TypeError(`${label}: string hex tidak valid`);
    }
    buf = Buffer.from(hex, 'hex');
  } else {
    throw new TypeError(`${label}: harus berupa Buffer atau string hex`);
  }

  if (buf.length !== expectedLen) {
    throw new RangeError(
      `${label}: panjang harus ${expectedLen} byte, diterima ${buf.length}`
    );
  }
  return buf;
}

/**
 * Hitung response kartu atas sebuah challenge: `AES-128(nonce, diversifiedKey)`.
 * Ini adalah sisi kartu pada challenge-response (Req 1.3) — mengenkripsi satu
 * blok nonce dengan diversified key.
 *
 * @param {Buffer|string} nonce            challenge 16 byte (Buffer atau hex).
 * @param {Buffer|string} diversifiedKey   kunci per-kartu 16 byte (Buffer atau hex).
 * @returns {Buffer} response (ciphertext) sepanjang 16 byte.
 */
function respond(nonce, diversifiedKey) {
  const nonceBuf = toBuffer(nonce, BLOCK_SIZE, 'nonce');
  const keyBuf = toBuffer(diversifiedKey, BLOCK_SIZE, 'diversifiedKey');

  const cipher = crypto.createCipheriv(CIPHER_ALGO, keyBuf, null);
  cipher.setAutoPadding(false); // satu blok tepat, tanpa padding
  return Buffer.concat([cipher.update(nonceBuf), cipher.final()]);
}

/**
 * Pulihkan nonce dari response dengan mendekripsi: `AES-128_decrypt(response, key)`.
 * Sisi firmware pada mutual auth — digunakan untuk membuktikan round-trip
 * (Property 2) dan sebagai dasar `verify`.
 *
 * @param {Buffer|string} response         response kartu 16 byte (Buffer atau hex).
 * @param {Buffer|string} diversifiedKey   kunci per-kartu 16 byte (Buffer atau hex).
 * @returns {Buffer} nonce hasil dekripsi sepanjang 16 byte.
 */
function recover(response, diversifiedKey) {
  const respBuf = toBuffer(response, BLOCK_SIZE, 'response');
  const keyBuf = toBuffer(diversifiedKey, BLOCK_SIZE, 'diversifiedKey');

  const decipher = crypto.createDecipheriv(CIPHER_ALGO, keyBuf, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(respBuf), decipher.final()]);
}

/**
 * Verifikasi kriptografis: terima IFF `response` cocok dengan hasil
 * `respond(nonce, diversifiedKey)` (Req 1.1). Perbandingan dilakukan secara
 * constant-time (`crypto.timingSafeEqual`) untuk menghindari kebocoran timing.
 *
 * Tahan input bermasalah: mengembalikan `false` (DENY, Req 1.5) alih-alih
 * melempar bila panjang tidak sesuai atau input tidak dapat dinormalisasi —
 * sehingga kartu yang hanya meniru UID atau mengirim response salah selalu
 * ditolak.
 *
 * @param {Buffer|string} nonce            challenge 16 byte yang dikirim.
 * @param {Buffer|string} response         response kartu yang akan diverifikasi.
 * @param {Buffer|string} diversifiedKey   kunci per-kartu 16 byte.
 * @returns {boolean} true iff response sah secara kriptografis.
 */
function verify(nonce, response, diversifiedKey) {
  let expected;
  let actual;
  try {
    expected = respond(nonce, diversifiedKey);
    actual = toBuffer(response, BLOCK_SIZE, 'response');
  } catch (_err) {
    // Input tidak valid / panjang tidak cocok → DENY, jangan melempar.
    return false;
  }

  // Panjang dijamin sama (keduanya BLOCK_SIZE), tetap jaga sebelum timingSafeEqual.
  if (expected.length !== actual.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * Hasilkan nonce acak kriptografis sepanjang 16 byte untuk dipakai sebagai
 * challenge (Req 1.3).
 *
 * @returns {Buffer} nonce acak 16 byte.
 */
function generateNonce() {
  return crypto.randomBytes(BLOCK_SIZE);
}

module.exports = {
  BLOCK_SIZE,
  respond,
  recover,
  verify,
  generateNonce,
};
