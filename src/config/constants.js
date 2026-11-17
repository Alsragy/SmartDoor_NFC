/** Batas alokasi kredensial per pintu (per node kunci kamar). */
export const QUOTA_PER_DOOR = Object.freeze({ resident: 1, admin: 2 });

export const ROLES = Object.freeze({
  resident: { value: 'resident', label: 'Penghuni', limit: QUOTA_PER_DOOR.resident },
  admin: { value: 'admin', label: 'Admin Pengelola', limit: QUOTA_PER_DOOR.admin },
});

export const ROLE_VALUES = Object.freeze(Object.keys(ROLES));

/** Baterai UPS di bawah ambang ini dianggap kritis. */
export const LOW_BATTERY_THRESHOLD = 20;

/** Lama sistem menunggu ESP32 membaca kartu fisik saat pendaftaran. */
export const ENROLLMENT_TIMEOUT_SECONDS = 30;

/** Kredensial dianggap "segera habis" bila sisa masa berlaku kurang dari ini. */
export const EXPIRING_SOON_DAYS = 3;

/** Solenoid otomatis terkunci kembali setelah durasi pulsa ini. */
export const AUTO_RELOCK_MS = 5000;

/** Rentang jeda lalu lintas tap acak yang dibangkitkan simulasi. */
export const AUTO_TRAFFIC_INTERVAL_MS = Object.freeze({ min: 6000, max: 11000 });

export const FLOORS = Object.freeze([1, 2, 3]);

export const DASHBOARD_OPERATOR = Object.freeze({
  name: 'Bambang Santoso',
  role: 'Super Admin',
  property: 'Kos Griya Harmoni',
});

export const LEDGER_NETWORK = 'Polygon L2 Mainnet';
