import {
  AUTO_RELOCK_MS,
  AUTO_TRAFFIC_INTERVAL_MS,
  DASHBOARD_OPERATOR,
  ROLES,
  ROLE_VALUES,
} from '../config/constants';
import { generateCardUid, generateId, generateTxHash, sha256Hex } from '../utils/ids';
import { sanitizeDate, sanitizeEnum, sanitizeName, sanitizePhone } from '../utils/sanitize';
import { ServiceError } from './contract';
import { createSeedState } from './mockData';

const randomBetween = (min, max) => min + Math.random() * (max - min);
const pick = (items) => items[Math.floor(Math.random() * items.length)];

/**
 * Sumber data simulasi: meniru gateway ESP32 Mesh + smart contract Polygon.
 *
 * - Menyimpan state di memori dan memberi tahu subscriber setiap ada perubahan
 *   (kompatibel dengan React `useSyncExternalStore`).
 * - Saat "internet" mati, setiap tap disimpan di antrean lokal (store-and-forward)
 *   lalu dikirim ke ledger sebagai "Susulan Luring" ketika koneksi pulih.
 *
 * @implements {import('./contract').DataSource}
 */
export class SimulationService {
  capabilities = Object.freeze({ simulation: true });

  #state;
  #listeners = new Set();
  #timers = new Set();
  #trafficTimer = null;
  #pendingTap = null;
  #running = false;

  constructor(initialState = createSeedState()) {
    this.#state = initialState;
  }

  // ---------------------------------------------------------------- store

  subscribe = (listener) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getState = () => this.#state;

  #update(producer) {
    this.#state = { ...this.#state, ...producer(this.#state) };
    this.#listeners.forEach((listener) => listener());
  }

  #updateNode(roomId, patch) {
    this.#update((s) => ({ nodes: { ...s.nodes, [roomId]: { ...s.nodes[roomId], ...patch } } }));
  }

  #later(fn, ms) {
    const id = setTimeout(() => {
      this.#timers.delete(id);
      fn();
    }, ms);
    this.#timers.add(id);
    return id;
  }

  /** Meniru latensi jaringan MQTT/RPC. */
  #latency(min = 350, max = 900) {
    return new Promise((resolve) => this.#later(resolve, randomBetween(min, max)));
  }

  // ------------------------------------------------------------ lifecycle

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#scheduleTraffic();
  }

  stop() {
    this.#running = false;
    this.#timers.forEach(clearTimeout);
    this.#timers.clear();
    this.#trafficTimer = null;
    this.#pendingTap?.reject(new ServiceError('ABORTED', 'Simulasi dihentikan.'));
    this.#pendingTap = null;
  }

  reset() {
    const wasRunning = this.#running;
    this.stop();
    this.#update(() => createSeedState());
    if (wasRunning) this.start();
  }

  // ------------------------------------------------------- connectivity

  #isReachable(roomId) {
    return this.#state.internetOnline && this.#state.nodes[roomId]?.hardwareOnline;
  }

  #assertReachable(roomId) {
    if (!this.#state.internetOnline) {
      throw new ServiceError('OFFLINE', 'Internet terputus. Perintah tidak dapat dikirim ke node.');
    }
    if (!this.#state.nodes[roomId]?.hardwareOnline) {
      throw new ServiceError('NODE_OFFLINE', `Node Kamar ${roomId} tidak merespons keep-alive MQTT.`);
    }
  }

  #assertInternet(action) {
    if (!this.#state.internetOnline) {
      throw new ServiceError('OFFLINE', `${action} membutuhkan koneksi internet ke smart contract.`);
    }
  }

  #assertRoom(roomId) {
    if (!this.#state.nodes[roomId]) throw new ServiceError('NOT_FOUND', 'Kamar tidak ditemukan.');
  }

  /** Simulasi saklar internet gateway. */
  setInternet(online) {
    this.#update(() => ({ internetOnline: Boolean(online) }));
    return { flushed: online ? this.#flushQueue() : 0 };
  }

  setAutoTraffic(enabled) {
    this.#update(() => ({ autoTraffic: Boolean(enabled) }));
  }

  async pingNode(roomId) {
    this.#assertRoom(roomId);
    this.#assertInternet('Ping node');
    await this.#latency(600, 1200);
    this.#updateNode(roomId, { hardwareOnline: true, rssi: -64 });
    return { flushed: this.#flushQueue() };
  }

  // -------------------------------------------------------------- ledger

  #nextBlock() {
    const blockNumber = this.#state.ledger.blockNumber + 1;
    this.#update((s) => ({ ledger: { ...s.ledger, blockNumber } }));
    return blockNumber;
  }

  #commit(event, syncMode) {
    const syncedAt = Date.now();
    const entry = {
      id: event.id ?? generateId('log'),
      eventAt: event.eventAt,
      syncedAt,
      roomId: event.roomId,
      name: event.name,
      direction: event.direction,
      method: event.method,
      syncMode,
      txHash: generateTxHash(),
      blockNumber: this.#nextBlock(),
    };
    this.#update((s) => {
      const node = s.nodes[event.roomId];
      const isNewer = !node.lastAccess || node.lastAccess.at <= event.eventAt;
      return {
        auditLog: [entry, ...s.auditLog].sort((a, b) => b.eventAt - a.eventAt),
        nodes: isNewer
          ? { ...s.nodes, [event.roomId]: { ...node, lastAccess: { at: event.eventAt, by: event.name, method: event.method } } }
          : s.nodes,
      };
    });
    return entry;
  }

  /** Catat akses: langsung ke ledger bila terjangkau, selain itu antre lokal. */
  #recordAccess(event) {
    const full = { ...event, eventAt: event.eventAt ?? Date.now() };
    if (this.#isReachable(full.roomId)) {
      return { queued: false, entry: this.#commit(full, 'realtime') };
    }
    const queued = {
      ...full,
      id: generateId('q'),
      reason: this.#state.internetOnline ? 'node' : 'internet',
    };
    this.#update((s) => ({ localQueue: [...s.localQueue, queued] }));
    return { queued: true, entry: queued };
  }

  /** Kirim antrean yang node-nya sudah terjangkau. Mengembalikan jumlah yang terkirim. */
  #flushQueue() {
    const ready = this.#state.localQueue.filter((e) => this.#isReachable(e.roomId));
    if (ready.length === 0) return 0;
    const readyIds = new Set(ready.map((e) => e.id));
    this.#update((s) => ({ localQueue: s.localQueue.filter((e) => !readyIds.has(e.id)) }));
    ready.forEach((event) => this.#commit(event, 'offline'));
    this.#update((s) => ({ ledger: { ...s.ledger, lastFlush: { count: ready.length, at: Date.now() } } }));
    return ready.length;
  }

  // --------------------------------------------------------------- doors

  async unlockDoor(roomId) {
    this.#assertRoom(roomId);
    this.#assertReachable(roomId);
    await this.#latency();
    this.#assertReachable(roomId);

    this.#updateNode(roomId, { lockState: 'unlocked' });
    const { entry } = this.#recordAccess({
      roomId,
      name: DASHBOARD_OPERATOR.name,
      direction: 'in',
      method: 'remote',
    });
    this.#later(() => this.#updateNode(roomId, { lockState: 'locked' }), AUTO_RELOCK_MS);
    return { txHash: entry.txHash };
  }

  /** Simulasi penghuni menempelkan kartu pada reader pintu. */
  simulateTap(roomId) {
    this.#assertRoom(roomId);
    const holder =
      this.#activeCredentials(roomId).find((c) => c.role === 'resident') ??
      this.#activeCredentials(roomId)[0];
    if (!holder) throw new ServiceError('NOT_FOUND', `Kamar ${roomId} belum punya kredensial aktif.`);

    const node = this.#state.nodes[roomId];
    const direction = node.presence === 'inside' ? 'out' : 'in';
    this.#updateNode(roomId, { presence: direction === 'in' ? 'inside' : 'outside' });
    const { queued } = this.#recordAccess({ roomId, name: holder.name, direction, method: 'nfc' });
    return { queued };
  }

  #scheduleTraffic() {
    if (!this.#running) return;
    const { min, max } = AUTO_TRAFFIC_INTERVAL_MS;
    this.#trafficTimer = this.#later(() => {
      if (this.#state.autoTraffic) {
        const occupied = this.#state.roomIds.filter((id) => this.#activeCredentials(id).length > 0);
        if (occupied.length > 0) this.simulateTap(pick(occupied));
      }
      this.#scheduleTraffic();
    }, randomBetween(min, max));
  }

  // --------------------------------------------------------- credentials

  #activeCredentials(roomId) {
    return this.#state.credentials.filter((c) => c.roomId === roomId && c.status === 'active');
  }

  getQuota(roomId, role) {
    const used = this.#activeCredentials(roomId).filter((c) => c.role === role).length;
    return { used, limit: ROLES[role]?.limit ?? 0 };
  }

  /**
   * Tunggu reader USB ESP32 membaca kartu fisik.
   * Di adapter produksi, ini menunggu event `reader/uid` dari MQTT.
   */
  waitForCardTap({ timeoutMs, signal }) {
    if (this.#pendingTap) {
      return Promise.reject(new ServiceError('BUSY', 'Reader sedang menunggu kartu lain.'));
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.#timers.delete(timer);
        signal?.removeEventListener('abort', onAbort);
        this.#pendingTap = null;
      };
      const onAbort = () => {
        cleanup();
        reject(new ServiceError('ABORTED', 'Pendaftaran dibatalkan.'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new ServiceError('TIMEOUT', 'Tidak ada kartu terdeteksi dalam batas waktu.'));
      }, timeoutMs);
      this.#timers.add(timer);

      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });

      this.#pendingTap = {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
    });
  }

  /** Tombol "Simulasikan Tap Sukses": kirim UID acak ke penunggu reader. */
  simulateCardTap() {
    if (!this.#pendingTap) return false;
    this.#pendingTap.resolve({ uid: generateCardUid() });
    return true;
  }

  async registerCredential(payload, uid) {
    // Validasi ulang di batas service: jangan percaya data dari UI.
    const clean = {
      name: sanitizeName(payload.name),
      phone: sanitizePhone(payload.phone),
      roomId: payload.roomId,
      role: sanitizeEnum(payload.role, ROLE_VALUES),
      validUntil: sanitizeDate(payload.validUntil),
    };
    if (clean.name.length < 3 || !clean.phone || !clean.role || !clean.validUntil) {
      throw new ServiceError('INVALID', 'Data pendaftaran tidak valid.');
    }
    this.#assertRoom(clean.roomId);
    this.#assertInternet('Pendaftaran kartu');

    const { used, limit } = this.getQuota(clean.roomId, clean.role);
    if (used >= limit) {
      throw new ServiceError(
        'QUOTA_EXCEEDED',
        `Kuota ${ROLES[clean.role].label} Kamar ${clean.roomId} penuh (${used}/${limit}).`,
      );
    }
    if (this.#state.credentials.some((c) => c.uid === uid && c.status === 'active')) {
      throw new ServiceError('DUPLICATE_UID', 'Kartu ini sudah terdaftar pada kredensial aktif lain.');
    }

    const uidHash = await sha256Hex(uid);
    await this.#latency(900, 1600);
    this.#assertInternet('Pendaftaran kartu');

    const credential = {
      id: generateId('cred'),
      ...clean,
      uid,
      uidHash,
      status: 'active',
      registeredAt: Date.now(),
      txHash: generateTxHash(),
    };
    this.#nextBlock();
    this.#update((s) => ({ credentials: [credential, ...s.credentials] }));
    return credential;
  }

  async revokeCredential(credentialId) {
    const target = this.#state.credentials.find((c) => c.id === credentialId);
    if (!target) throw new ServiceError('NOT_FOUND', 'Kredensial tidak ditemukan.');
    this.#assertInternet('Pencabutan akses');
    await this.#latency(700, 1300);
    this.#assertInternet('Pencabutan akses');

    const txHash = generateTxHash();
    this.#nextBlock();
    this.#update((s) => ({
      credentials: s.credentials.map((c) =>
        c.id === credentialId ? { ...c, status: 'revoked', revokedAt: Date.now(), revokeTxHash: txHash } : c,
      ),
    }));
    return { txHash };
  }
}
