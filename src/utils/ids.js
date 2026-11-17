/** Pembangkit ID & hash dummy untuk simulasi. */

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const randomHex = (byteLength) => toHex(randomBytes(byteLength));

/** Hash transaksi gaya EVM: 0x + 64 hex. */
export const generateTxHash = () => `0x${randomHex(32)}`;

/** UID kartu MIFARE 4 byte: 04:A2:8F:9C */
export function generateCardUid() {
  const bytes = randomBytes(4);
  bytes[0] = 0x04;
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

export const generateId = (prefix) => `${prefix}_${randomHex(6)}`;

/** SHA-256 hex. Memakai Web Crypto (tersedia di localhost / HTTPS). */
export async function sha256Hex(text) {
  if (!crypto.subtle) return randomHex(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}
