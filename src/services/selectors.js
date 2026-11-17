import { EXPIRING_SOON_DAYS, LOW_BATTERY_THRESHOLD } from '../config/constants';
import { daysUntil, isSameDay } from '../utils/format';

/**
 * Fungsi turunan murni dari DormChainState. Dipakai lewat useMemo di komponen
 * sehingga logika tampilan tidak tersebar di banyak tempat.
 */

/** @param {import('./contract').DormChainState} state */
export function selectRoomViews(state) {
  return state.roomIds.map((roomId) => {
    const node = state.nodes[roomId];
    const active = state.credentials.filter((c) => c.roomId === roomId && c.status === 'active');
    const resident = active.find((c) => c.role === 'resident') ?? null;
    return {
      roomId,
      floor: node.floor,
      node,
      resident,
      admins: active.filter((c) => c.role === 'admin'),
      occupied: Boolean(resident),
      online: state.internetOnline && node.hardwareOnline,
      lowBattery: node.battery < LOW_BATTERY_THRESHOLD,
      queued: state.localQueue.filter((e) => e.roomId === roomId).length,
    };
  });
}

/** Status tampilan kredensial: revoked | expired | expiring | active. */
export function selectCredentialStatus(credential, now = Date.now()) {
  if (credential.status === 'revoked') return 'revoked';
  const days = daysUntil(credential.validUntil, now);
  if (days < 0) return 'expired';
  if (days <= EXPIRING_SOON_DAYS) return 'expiring';
  return 'active';
}

/** @param {import('./contract').DormChainState} state */
export function selectSummary(state, rooms = selectRoomViews(state), now = Date.now()) {
  const todayLogs = state.auditLog.filter((e) => isSameDay(e.eventAt, now));
  const activeCredentials = state.credentials.filter((c) => c.status === 'active');
  return {
    totalRooms: rooms.length,
    occupied: rooms.filter((r) => r.occupied).length,
    online: rooms.filter((r) => r.online).length,
    offline: rooms.filter((r) => !r.online).length,
    lowBatteryRooms: rooms.filter((r) => r.lowBattery).sort((a, b) => a.node.battery - b.node.battery),
    todayLogs: todayLogs.length,
    todayRealtime: todayLogs.filter((e) => e.syncMode === 'realtime').length,
    todayOffline: todayLogs.filter((e) => e.syncMode === 'offline').length,
    queueLength: state.localQueue.length,
    activeCredentials: activeCredentials.length,
    residentCredentials: activeCredentials.filter((c) => c.role === 'resident').length,
    adminCredentials: activeCredentials.filter((c) => c.role === 'admin').length,
  };
}
