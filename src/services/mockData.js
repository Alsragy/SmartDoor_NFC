import { FLOORS, LEDGER_NETWORK } from '../config/constants';
import { isoDateFromNow } from '../utils/format';
import { generateTxHash } from '../utils/ids';

const ROOMS_PER_FLOOR = 8;
const INITIAL_BLOCK = 54_219_842;

/** Penghuni utama per kamar. Kamar yang tidak ada di sini = kosong. */
const RESIDENTS = [
  ['101', 'Budi Santoso', '+62 812-8890-1123', 'BS01'],
  ['102', 'Siti Rahmawati', '+62 856-4200-8819', 'SR02'],
  ['103', 'Andi Wijaya', '+62 813-2201-7781', 'AW03'],
  ['104', 'Dimas Arya', '+62 822-7711-0099', 'DA04', 1],
  ['106', 'Nadia Putri', '+62 811-4456-2210', 'NP06'],
  ['107', 'Fajar Nugraha', '+62 857-3321-9087', 'FN07'],
  ['108', 'Rina Kartika', '+62 819-2234-5567', 'RK08'],
  ['201', 'Rian Pratama', '+62 899-2311-6678', 'RP21'],
  ['202', 'Yoga Saputra', '+62 812-6654-3321', 'YS22'],
  ['203', 'Kevin Wijaya', '+62 813-9002-3341', 'KW23'],
  ['204', 'Lestari Ayu', '+62 838-1209-4456', 'LA24'],
  ['205', 'Bagas Pranata', '+62 821-7790-1123', 'BP25'],
  ['206', 'Maya Sari', '+62 852-3398-7765', 'MS26'],
  ['208', 'Aulia Putri', '+62 878-1122-9904', 'AP28'],
  ['301', 'Farhan Malik', '+62 815-6678-2234', 'FM31'],
  ['302', 'Bayu Nugroho', '+62 817-4410-9988', 'BN32'],
  ['304', 'Citra Lestari', '+62 856-1123-4490', 'CL34'],
  ['306', 'Gilang Ramadhan', '+62 812-0098-7765', 'GR36'],
];

const ADMINS = [
  ['101', 'Pak Hendra', '+62 811-3444-9001', 'PH01'],
  ['201', 'Pak Hendra', '+62 811-3444-9001', 'PH21'],
  ['105', 'Bu Nur', '+62 821-6550-9988', 'BN05'],
];

/** Kondisi hardware yang menyimpang dari normal, untuk memicu peringatan. */
const NODE_OVERRIDES = {
  104: { battery: 12, voltage: 3.2, rssi: -61 },
  203: { hardwareOnline: false, battery: 65, rssi: -78 },
  208: { battery: 15, voltage: 3.3, rssi: -55 },
  302: { battery: 8, voltage: 2.9, rssi: -66 },
};

const uidFromSeed = (seed) => {
  const hex = Array.from(seed, (c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  return ['04', ...hex.slice(1, 4)].join(':');
};

/** Hash dummy deterministik agar tampilan seed stabil antar reload. */
const fakeUidHash = (seed) => {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Array.from({ length: 8 }, (_, i) => ((h >>> (i * 4)) ^ (i * 2654435761)) >>> 0)
    .map((n) => n.toString(16).padStart(8, '0').slice(0, 8))
    .join('');
};

function buildNodes(roomIds) {
  return Object.fromEntries(
    roomIds.map((roomId, index) => {
      const battery = 72 + ((index * 7) % 27);
      return [
        roomId,
        {
          roomId,
          floor: Number(roomId[0]),
          hardwareOnline: true,
          battery,
          voltage: Number((3.6 + battery / 250).toFixed(2)),
          rssi: -48 - ((index * 3) % 14),
          lockState: 'locked',
          presence: 'outside',
          lastAccess: null,
          ...NODE_OVERRIDES[roomId],
        },
      ];
    }),
  );
}

function buildCredentials(now) {
  const make = (role) => ([roomId, name, phone, seed, expiresInDays], i) => ({
    id: `cred_${seed.toLowerCase()}`,
    name,
    phone,
    roomId,
    role,
    uid: uidFromSeed(seed),
    uidHash: fakeUidHash(seed),
    validUntil: isoDateFromNow(expiresInDays ?? (role === 'admin' ? 365 : 60 + i * 9)),
    status: 'active',
    registeredAt: now - (40 + i) * 86_400_000,
    txHash: generateTxHash(),
  });
  return [...RESIDENTS.map(make('resident')), ...ADMINS.map(make('admin'))];
}

/** Riwayat akses awal (hari ini), sebagian merupakan susulan luring. */
function buildAuditLog(now, credentials) {
  const byRoom = (roomId, role = 'resident') =>
    credentials.find((c) => c.roomId === roomId && c.role === role)?.name ?? 'Tidak dikenal';
  const minutesAgo = (m) => now - m * 60_000;

  const rows = [
    { m: 3, roomId: '101', direction: 'in', method: 'nfc' },
    { m: 16, roomId: '104', direction: 'out', method: 'sensor' },
    { m: 39, roomId: '203', direction: 'in', method: 'nfc', offlineFor: 18 },
    { m: 52, roomId: '102', direction: 'in', method: 'remote', name: 'Bambang Santoso' },
    { m: 125, roomId: '203', direction: 'out', method: 'nfc', offlineFor: 105 },
    { m: 210, roomId: '208', direction: 'in', method: 'nfc' },
    { m: 290, roomId: '105', direction: 'in', method: 'nfc', role: 'admin' },
    { m: 355, roomId: '301', direction: 'out', method: 'nfc' },
    { m: 402, roomId: '201', direction: 'in', method: 'nfc', role: 'admin' },
    { m: 430, roomId: '306', direction: 'out', method: 'nfc', offlineFor: 40 },
    { m: 470, roomId: '106', direction: 'out', method: 'nfc' },
  ];

  let block = INITIAL_BLOCK;
  return rows.map((row, i) => {
    const eventAt = minutesAgo(row.m);
    return {
      id: `log_seed_${i}`,
      eventAt,
      syncedAt: row.offlineFor ? eventAt + row.offlineFor * 60_000 : eventAt,
      roomId: row.roomId,
      name: row.name ?? byRoom(row.roomId, row.role),
      direction: row.direction,
      method: row.method,
      syncMode: row.offlineFor ? 'offline' : 'realtime',
      txHash: generateTxHash(),
      blockNumber: block--,
    };
  });
}

/** @returns {import('./contract').DormChainState} */
export function createSeedState(now = Date.now()) {
  const roomIds = FLOORS.flatMap((floor) =>
    Array.from({ length: ROOMS_PER_FLOOR }, (_, i) => `${floor}${String(i + 1).padStart(2, '0')}`),
  );
  const credentials = buildCredentials(now);

  return {
    internetOnline: true,
    autoTraffic: true,
    ledger: {
      network: LEDGER_NETWORK,
      blockNumber: INITIAL_BLOCK,
      contractAddress: '0x8B3f41c9D2e07a6B5c1E8d93a0F4b27C6e5d8E24',
      pingMs: 24,
      lastFlush: null,
    },
    roomIds,
    nodes: buildNodes(roomIds),
    credentials,
    auditLog: buildAuditLog(now, credentials),
    localQueue: [],
  };
}
