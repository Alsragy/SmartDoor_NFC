import { StatusChip } from '../ui/StatusChip';

/** Badge status sinkronisasi baris log: real-time vs susulan luring. */
export function SyncBadge({ mode }) {
  return mode === 'offline' ? (
    <StatusChip tone="warning" icon="cloud_sync">
      Susulan Luring
    </StatusChip>
  ) : (
    <StatusChip tone="success" dot>
      Real-time
    </StatusChip>
  );
}

export function DirectionBadge({ direction }) {
  return direction === 'in' ? (
    <StatusChip tone="success" icon="login">
      Masuk
    </StatusChip>
  ) : (
    <StatusChip tone="info" icon="logout">
      Keluar
    </StatusChip>
  );
}
