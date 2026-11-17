export const NAV_ITEMS = Object.freeze([
  { route: 'overview', label: 'Ringkasan & Monitoring', shortLabel: 'Ringkasan', icon: 'monitoring' },
  { route: 'doors', label: 'Kontrol Pintu & Kamar', shortLabel: 'Pintu', icon: 'meeting_room' },
  { route: 'users', label: 'Manajemen Pengguna NFC', shortLabel: 'Pengguna', icon: 'badge' },
  { route: 'audit', label: 'Log Audit & Blockchain', shortLabel: 'Audit', icon: 'history_edu' },
]);

export const ROUTES = NAV_ITEMS.map((item) => item.route);
export const DEFAULT_ROUTE = 'overview';
