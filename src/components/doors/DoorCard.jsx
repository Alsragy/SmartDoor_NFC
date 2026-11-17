import { memo } from 'react';
import { cx } from '../../utils/cx';
import { formatShortTime } from '../../utils/format';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { StatusChip } from '../ui/StatusChip';
import { BatteryIndicator } from './BatteryIndicator';

const METHOD_LABEL = { nfc: 'Kartu NFC', remote: 'Remote Dashboard', sensor: 'Sensor Dalam' };

function cardState(room) {
  if (!room.online) return { frame: 'border-critical/40 shadow-glow-critical', tone: 'critical' };
  if (room.lowBattery) return { frame: 'border-tertiary/40 shadow-glow-tertiary', tone: 'warning' };
  return { frame: 'border-white/8', tone: 'success' };
}

/**
 * Kartu node kunci satu kamar: status hunian, konektivitas, baterai UPS,
 * keadaan solenoid, dan tombol buka pintu jarak jauh.
 */
export const DoorCard = memo(function DoorCard({ room, internetOnline, onRequestUnlock }) {
  const { node } = room;
  const state = cardState(room);
  const unlocked = node.lockState === 'unlocked';
  const offlineReason = !internetOnline ? 'Internet gateway OFF' : 'Node ESP32 tidak merespons';

  return (
    <article
      aria-label={`Kamar ${room.roomId}`}
      className={cx('flex flex-col gap-4 rounded-2xl border bg-surface-container p-5 transition', state.frame)}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="font-display text-headline-lg text-white">{room.roomId}</h3>
          <span className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">Lt. {room.floor}</span>
        </div>
        {room.online ? (
          <StatusChip tone="success" dot pulse>
            Online • {node.rssi} dBm
          </StatusChip>
        ) : (
          <StatusChip tone="critical" dot>
            Offline
          </StatusChip>
        )}
      </header>

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={cx('truncate text-sm font-semibold', room.occupied ? 'text-slate-100' : 'text-slate-500')}>
            {room.resident?.name ?? 'Kamar kosong'}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <StatusChip tone={room.occupied ? 'info' : 'neutral'}>{room.occupied ? 'Terisi' : 'Kosong'}</StatusChip>
            {room.admins.length > 0 && <StatusChip tone="neutral">{room.admins.length} admin</StatusChip>}
          </div>
        </div>
        <BatteryIndicator percent={node.battery} voltage={node.voltage} />
      </div>

      <div className="inset-well flex items-center gap-3 p-3">
        <Icon
          name={unlocked ? 'lock_open' : 'lock'}
          size={22}
          className={unlocked ? 'text-secondary-light' : 'text-primary-light'}
        />
        <div className="min-w-0 flex-1">
          <p className={cx('text-sm font-semibold', unlocked ? 'text-secondary-light' : 'text-slate-100')}>
            {unlocked ? 'Solenoid Terbuka' : 'Solenoid Terkunci'}
          </p>
          <p className="truncate text-xs text-slate-400">
            {room.online ? (unlocked ? 'Auto-relock 5 detik' : 'Reed switch: rapat') : offlineReason}
          </p>
        </div>
        {room.queued > 0 && (
          <StatusChip tone="warning" icon="inventory_2">
            {room.queued}
          </StatusChip>
        )}
      </div>

      {room.lowBattery && (
        <p className="flex items-start gap-2 rounded-lg border border-tertiary/30 bg-tertiary/8 p-2.5 text-xs text-tertiary-light">
          <Icon name="warning" size={16} />
          Baterai UPS {node.battery}% ({node.voltage} V). Segera ganti agar auto-lock tidak gagal.
        </p>
      )}

      <p className="text-xs text-slate-500">
        Akses terakhir:{' '}
        {node.lastAccess ? (
          <span className="text-slate-300">
            {formatShortTime(node.lastAccess.at)} WIB • {METHOD_LABEL[node.lastAccess.method]}
          </span>
        ) : (
          '-'
        )}
      </p>

      <Button
        variant="primary"
        icon="lock_open"
        className="mt-auto w-full"
        disabled={!room.online || unlocked}
        title={!room.online ? `Tidak tersedia: ${offlineReason}` : undefined}
        onClick={() => onRequestUnlock(room)}
      >
        {unlocked ? 'Pintu Terbuka' : 'Buka Pintu Jarak Jauh'}
      </Button>
    </article>
  );
});
