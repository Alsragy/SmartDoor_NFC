'use strict';

/**
 * Derivasi Diversified_Key — Smart Door KOS ESP32 (Web Server Node.js).
 *
 * Menurunkan kunci per-kartu (Diversified_Key) dari Master_Key dan UID kartu,
 * konsisten dengan skema di design.md:
 *
 *     diversified_key = CMAC-AES128(Master_Key, UID || label_konstanta)
 *
 * Master_Key TIDAK PERNAH di-hardcode. Modul ini menerima masterKey sebagai
 * parameter dan menyediakan helper `loadMasterKey()` untuk membacanya dari
 * environment (`SMARTDOOR_MASTER_KEY`). Derivasi bersifat deterministik:
 * UID yang sama (dengan Master_Key sama) selalu menghasilkan kunci sama, dan
 * dua UID berbeda menghasilkan kunci berbeda.
 *
 * Node.js `crypto` tidak menyediakan CMAC secara langsung, maka AES-CMAC
 * (RFC 4493) diimplementasikan di atas AES-128-CBC. Hasilnya adalah tag MAC
 * 16-byte yang dipakai sebagai Diversified_Key (AES-128).
 *
 * _Requirements: 1.4, 2.2_
 */

const crypto = require('crypto');

/** Ukuran blok AES-128 dalam byte. */
const AES_BLOCK_SIZE = 16;

/**
 * Nama variabel environment yang menyimpan Master_Key (hex 32 char = 16 byte).
 * Master_Key TIDAK di-hardcode; wajib disediakan lewat env/config.
 */
const MASTER_KEY_ENV = 'SMARTDOOR_MASTER_KEY';

/** Nama variabel environment opsional untuk key_version (default 1). */
const KEY_VERSION_ENV = 'SMARTDOOR_KEY_VERSION';

/**
 * Label konstanta yang dirangkai setelah UID sebelum CMAC (UID || label).
 * Memisahkan ruang derivasi ini dari penggunaan Master_Key lain. Nilai dapat
 * di-override via env `SMARTDOOR_KDF_LABEL` bila diperlukan konsistensi lintas
 * sistem; default konstan agar deterministik.
 */
const DEFAULT_KDF_LABEL = 'SmartDoorKOS/diversify/v1';

/** key_version default bila tidak di-set via env/argumen. */
const DEFAULT_KEY_VERSION = 1;

/**
 * Normalisasi sebuah input kunci/uid menjadi Buffer.
 * - Buffer dikembalikan apa adanya.
 * - String hex (genap, hanya [0-9a-fA-F]) di-decode sebagai hex.
 * - String lain diperlakukan sebagai UTF-8.
 * @param {Buffer|string} value
 * @param {string} name  nama argumen untuk pesan error.
 * @returns {Buffer}
 */
function toBuffer(value, name) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const isHex = value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
    return isHex ? Buffer.from(value, 'hex') : Buffer.from(value, 'utf8');
  }
  throw new TypeError(`${name} harus berupa Buffer atau string`);
}

/**
 * Geser-kiri 1 bit sebuah blok 16-byte (operasi subkey RFC 4493).
 * @param {Buffer} input blok 16-byte.
 * @returns {Buffer} blok 16-byte hasil shift-left.
 */
function leftShiftOneBit(input) {
  const output = Buffer.alloc(input.length);
  let carry = 0;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const cur = input[i];
    output[i] = ((cur << 1) & 0xff) | carry;
    carry = (cur & 0x80) ? 1 : 0;
  }
  return output;
}

/** XOR dua buffer berukuran sama menjadi buffer baru. */
function xorBuffers(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) {
    out[i] = a[i] ^ b[i];
  }
  return out;
}

/**
 * Enkripsi satu blok 16-byte dengan AES-128-ECB (primitif untuk CMAC).
 * ECB atas satu blok setara dengan AES block cipher tunggal.
 * @param {Buffer} key  kunci AES-128 (16 byte).
 * @param {Buffer} block blok 16-byte.
 * @returns {Buffer} ciphertext 16-byte.
 */
function aesEcbEncryptBlock(key, block) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

/**
 * Hasilkan subkey K1 dan K2 sesuai RFC 4493 (AES-CMAC key generation).
 * @param {Buffer} key kunci AES-128 (16 byte).
 * @returns {{ k1: Buffer, k2: Buffer }}
 */
function generateSubkeys(key) {
  const Rb = 0x87;
  const L = aesEcbEncryptBlock(key, Buffer.alloc(AES_BLOCK_SIZE));

  let k1 = leftShiftOneBit(L);
  if (L[0] & 0x80) {
    k1[AES_BLOCK_SIZE - 1] ^= Rb;
  }

  let k2 = leftShiftOneBit(k1);
  if (k1[0] & 0x80) {
    k2[AES_BLOCK_SIZE - 1] ^= Rb;
  }

  return { k1, k2 };
}

/**
 * Hitung AES-CMAC (RFC 4493) atas `message` dengan `key` AES-128.
 * @param {Buffer} key  kunci AES-128 (16 byte).
 * @param {Buffer} message pesan sembarang panjang (boleh kosong).
 * @returns {Buffer} tag MAC 16-byte.
 */
function aesCmac(key, message) {
  if (key.length !== AES_BLOCK_SIZE) {
    throw new RangeError('aesCmac: kunci harus AES-128 (16 byte)');
  }

  const { k1, k2 } = generateSubkeys(key);

  const n = Math.ceil(message.length / AES_BLOCK_SIZE);
  const complete = n !== 0 && message.length % AES_BLOCK_SIZE === 0;
  const blockCount = n === 0 ? 1 : n;

  // Siapkan blok terakhir (M_last).
  let mLast;
  if (complete) {
    const lastBlock = message.subarray((blockCount - 1) * AES_BLOCK_SIZE, blockCount * AES_BLOCK_SIZE);
    mLast = xorBuffers(lastBlock, k1);
  } else {
    // Padding: 0x80 lalu 0x00... hingga 16 byte.
    const remaining = message.length - (blockCount - 1) * AES_BLOCK_SIZE;
    const padded = Buffer.alloc(AES_BLOCK_SIZE);
    message.copy(padded, 0, (blockCount - 1) * AES_BLOCK_SIZE, (blockCount - 1) * AES_BLOCK_SIZE + remaining);
    padded[remaining] = 0x80;
    mLast = xorBuffers(padded, k2);
  }

  // CBC-MAC atas blok 0..n-2, lalu blok terakhir (M_last).
  let x = Buffer.alloc(AES_BLOCK_SIZE);
  for (let i = 0; i < blockCount - 1; i += 1) {
    const block = message.subarray(i * AES_BLOCK_SIZE, (i + 1) * AES_BLOCK_SIZE);
    x = aesEcbEncryptBlock(key, xorBuffers(x, block));
  }
  const tag = aesEcbEncryptBlock(key, xorBuffers(x, mLast));
  return tag;
}

/**
 * Baca Master_Key dari environment (`SMARTDOOR_MASTER_KEY`).
 * Master_Key TIDAK PERNAH di-hardcode — harus disediakan lewat env/config.
 * Nilai diharapkan hex 32 karakter (16 byte, AES-128).
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {Buffer} Master_Key 16-byte.
 * @throws {Error} bila env tidak di-set atau ukuran salah.
 */
function loadMasterKey(env = process.env) {
  const raw = env[MASTER_KEY_ENV];
  if (!raw) {
    throw new Error(
      `Master_Key tidak ditemukan: set environment variable ${MASTER_KEY_ENV} (hex AES-128, 32 char).`,
    );
  }
  const key = toBuffer(raw, MASTER_KEY_ENV);
  if (key.length !== AES_BLOCK_SIZE) {
    throw new Error(
      `Master_Key harus AES-128 (16 byte / 32 hex char); diterima ${key.length} byte.`,
    );
  }
  return key;
}

/**
 * Baca key_version default dari environment (`SMARTDOOR_KEY_VERSION`), fallback 1.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {number} integer key version (>= 0).
 */
function loadKeyVersion(env = process.env) {
  const raw = env[KEY_VERSION_ENV];
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_KEY_VERSION;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${KEY_VERSION_ENV} harus berupa integer >= 0; diterima "${raw}".`);
  }
  return parsed;
}

/**
 * Derive Diversified_Key untuk sebuah kartu dari Master_Key dan UID.
 *
 *     diversified_key = CMAC-AES128(masterKey, UID || label_konstanta)
 *
 * Deterministik: (masterKey, uid) yang sama selalu menghasilkan kunci sama;
 * dua UID berbeda menghasilkan kunci berbeda (Property 3).
 *
 * @param {Buffer|string} masterKey Master_Key AES-128 (16 byte / 32 hex char).
 *   WAJIB diberikan sebagai argumen (dibaca dari env via `loadMasterKey`),
 *   tidak di-hardcode.
 * @param {Buffer|string} uid UID kartu (Buffer, atau string hex/utf8).
 * @param {object} [options]
 * @param {number} [options.keyVersion] key_version; default dari env/`1`.
 * @param {string} [options.label] label konstanta; default `DEFAULT_KDF_LABEL`
 *   (atau env `SMARTDOOR_KDF_LABEL`).
 * @returns {{ diversifiedKey: Buffer, keyVersion: number }}
 *   `diversifiedKey` adalah Buffer 16-byte (gunakan `.toString('hex')` bila
 *   butuh representasi hex).
 */
function derive(masterKey, uid, options = {}) {
  const keyBuf = toBuffer(masterKey, 'masterKey');
  if (keyBuf.length !== AES_BLOCK_SIZE) {
    throw new RangeError('derive: masterKey harus AES-128 (16 byte / 32 hex char).');
  }
  if (uid === undefined || uid === null) {
    throw new TypeError('derive: uid wajib diisi.');
  }
  const uidBuf = toBuffer(uid, 'uid');

  const label = options.label !== undefined
    ? options.label
    : (process.env.SMARTDOOR_KDF_LABEL || DEFAULT_KDF_LABEL);
  const labelBuf = Buffer.from(label, 'utf8');

  const message = Buffer.concat([uidBuf, labelBuf]);
  const diversifiedKey = aesCmac(keyBuf, message);

  const keyVersion = options.keyVersion !== undefined
    ? options.keyVersion
    : loadKeyVersion();

  if (!Number.isInteger(keyVersion) || keyVersion < 0) {
    throw new RangeError('derive: keyVersion harus integer >= 0.');
  }

  return { diversifiedKey, keyVersion };
}

module.exports = {
  derive,
  loadMasterKey,
  loadKeyVersion,
  aesCmac,
  MASTER_KEY_ENV,
  KEY_VERSION_ENV,
  DEFAULT_KEY_VERSION,
  DEFAULT_KDF_LABEL,
};
