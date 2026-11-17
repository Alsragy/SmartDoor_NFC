/**
 * Sanitasi & validasi input form.
 *
 * React sudah meng-escape output teks, tetapi input tetap dibersihkan di sini
 * karena nilainya nanti diteruskan ke MQTT payload / API / smart contract.
 * Aturan yang sama dipanggil ulang di service layer (batas kepercayaan).
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F]/g;
const MARKUP_CHARS = /[<>`"\\{}$;]/g;
const NAME_DISALLOWED = /[^\p{L}\p{M}\s.'-]/gu;

/**
 * Bersihkan teks bebas.
 * @param {unknown} value
 * @param {{ maxLength?: number, trim?: boolean }} [options]
 *   `trim: false` dipakai saat pengguna masih mengetik agar spasi di akhir tidak hilang.
 */
export function sanitizeText(value, { maxLength = 80, trim = true } = {}) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .normalize('NFKC')
    .replace(CONTROL_CHARS, '')
    .replace(MARKUP_CHARS, '')
    .replace(/\s+/g, ' ')
    .trimStart()
    .slice(0, maxLength);
  return trim ? cleaned.trimEnd() : cleaned;
}

export function sanitizeName(value, options) {
  return sanitizeText(value, { maxLength: 60, ...options }).replace(NAME_DISALLOWED, '');
}

export function sanitizePhone(value, { trim = true } = {}) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/[^\d+\s-]/g, '')
    .replace(/(?!^)\+/g, '')
    .replace(/\s+/g, ' ')
    .trimStart()
    .slice(0, 20);
  return trim ? cleaned.trimEnd() : cleaned;
}

export function sanitizeSearch(value) {
  return sanitizeText(value, { maxLength: 64, trim: false });
}

/** Kembalikan nilai bila termasuk daftar yang diizinkan, selain itu `fallback`. */
export function sanitizeEnum(value, allowed, fallback = '') {
  return allowed.includes(value) ? value : fallback;
}

/** Tanggal format YYYY-MM-DD (input type="date"). */
export function sanitizeDate(value) {
  if (typeof value !== 'string') return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

const PHONE_PATTERN = /^\+?\d[\d\s-]{7,17}$/;
const MAX_VALIDITY_DAYS = 730;

/**
 * Validasi form pendaftaran kartu.
 * @returns {Record<string, string>} pesan error per field (kosong = valid)
 */
export function validateEnrollmentForm(form, { roomIds, roleValues }) {
  const errors = {};
  const name = sanitizeName(form.name);
  const phone = sanitizePhone(form.phone);

  if (name.length < 3) errors.name = 'Nama minimal 3 karakter (huruf, spasi, titik, tanda hubung).';
  if (!PHONE_PATTERN.test(phone)) errors.phone = 'Nomor telepon tidak valid. Contoh: +62 812-3456-7890.';
  if (!roomIds.includes(form.roomId)) errors.roomId = 'Pilih kamar yang tersedia.';
  if (!roleValues.includes(form.role)) errors.role = 'Pilih tipe kredensial.';

  const validUntil = sanitizeDate(form.validUntil);
  if (!validUntil) {
    errors.validUntil = 'Tentukan masa berlaku.';
  } else {
    const days = (new Date(`${validUntil}T23:59:59`).getTime() - Date.now()) / 86_400_000;
    if (days < 1) errors.validUntil = 'Masa berlaku harus setelah hari ini.';
    else if (days > MAX_VALIDITY_DAYS) errors.validUntil = 'Masa berlaku maksimal 2 tahun.';
  }

  return errors;
}
