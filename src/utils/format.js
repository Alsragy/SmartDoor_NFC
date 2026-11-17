const TIME_ZONE = 'Asia/Jakarta';

const timeFormatter = new Intl.DateTimeFormat('id-ID', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: TIME_ZONE,
});

const shortTimeFormatter = new Intl.DateTimeFormat('id-ID', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: TIME_ZONE,
});

const dateFormatter = new Intl.DateTimeFormat('id-ID', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: TIME_ZONE,
});

const numberFormatter = new Intl.NumberFormat('en-US');

export const formatTime = (ts) => timeFormatter.format(ts).replaceAll('.', ':');
export const formatShortTime = (ts) => shortTimeFormatter.format(ts).replaceAll('.', ':');
export const formatDate = (ts) => dateFormatter.format(ts);
export const formatNumber = (n) => numberFormatter.format(n);

export function isSameDay(a, b) {
  return formatDate(a) === formatDate(b);
}

/** "Hari ini • 24 Okt 2026" atau tanggal saja untuk hari lain. */
export function formatDayLabel(ts, now = Date.now()) {
  return isSameDay(ts, now) ? `Hari ini • ${formatDate(ts)}` : formatDate(ts);
}

export function formatRelative(ts, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return `${seconds} dtk lalu`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} mnt lalu`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  return formatDate(ts);
}

/** Potong hash di tengah: 0x7f2a...a94c */
export function truncateMiddle(value, head = 6, tail = 4) {
  if (!value || value.length <= head + tail + 3) return value ?? '';
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

/** Hitung sisa hari hingga akhir tanggal `isoDate` (YYYY-MM-DD). */
export function daysUntil(isoDate, now = Date.now()) {
  const end = new Date(`${isoDate}T23:59:59`).getTime();
  return Math.ceil((end - now) / 86_400_000);
}

export function formatIsoDate(isoDate) {
  return formatDate(new Date(`${isoDate}T12:00:00`));
}

/** Tanggal lokal YYYY-MM-DD, `offsetDays` hari dari sekarang. */
export function isoDateFromNow(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
