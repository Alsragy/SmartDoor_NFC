import { cx } from '../../utils/cx';
import { formatDayLabel, formatNumber, formatShortTime, formatTime } from '../../utils/format';
import { HashText } from '../ui/HashText';
import { Icon } from '../ui/Icon';
import { DirectionBadge, SyncBadge } from './SyncBadge';

const METHOD = {
  nfc: { icon: 'contactless', label: 'Kartu NFC' },
  remote: { icon: 'settings_remote', label: 'Remote Dashboard' },
  sensor: { icon: 'sensors', label: 'Sensor Pintu Dalam' },
};

const HEADERS = ['Waktu & Tanggal (WIB)', 'Kamar', 'Nama', 'Arah', 'Metode', 'ID Transaksi (Hash)', 'Sinkronisasi'];

function TimeCell({ entry, now }) {
  const offline = entry.syncMode === 'offline';
  return (
    <>
      <p className={cx('font-mono text-label-mono-md font-semibold', offline ? 'text-tertiary-light' : 'text-slate-100')}>
        {formatTime(entry.eventAt)}
      </p>
      <p className={cx('mt-0.5 text-xs', offline ? 'font-mono text-tertiary-light' : 'text-slate-500')}>
        {offline ? `Disinkronkan ${formatShortTime(entry.syncedAt)} WIB` : formatDayLabel(entry.eventAt, now)}
      </p>
    </>
  );
}

function RoomTag({ roomId, offline }) {
  return (
    <span
      className={cx(
        'rounded-md border px-2 py-1 font-mono text-label-mono-sm',
        offline ? 'border-tertiary/40 bg-tertiary/10 text-tertiary-light' : 'border-white/10 bg-white/5 text-slate-200',
      )}
    >
      Kamar {roomId}
    </span>
  );
}

/** Tabel riwayat akses ledger (desktop) / kartu bertumpuk (mobile). */
export function AuditTable({ entries, now }) {
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-slate-400">
        <Icon name="search_off" size={28} />
        Tidak ada log yang cocok dengan filter.
      </div>
    );
  }

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[960px] text-left">
          <thead>
            <tr className="border-b border-white/6">
              {HEADERS.map((h) => (
                <th key={h} scope="col" className="eyebrow px-5 py-4">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const offline = entry.syncMode === 'offline';
              const method = METHOD[entry.method];
              return (
                <tr
                  key={entry.id}
                  className={cx('border-b border-white/4 transition last:border-0', offline ? 'bg-tertiary/5 hover:bg-tertiary/8' : 'hover:bg-white/2')}
                >
                  <td className="px-5 py-3.5">
                    <TimeCell entry={entry} now={now} />
                  </td>
                  <td className="px-5 py-3.5">
                    <RoomTag roomId={entry.roomId} offline={offline} />
                  </td>
                  <td className="px-5 py-3.5 text-sm font-semibold text-slate-100">{entry.name}</td>
                  <td className="px-5 py-3.5">
                    <DirectionBadge direction={entry.direction} />
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="flex items-center gap-2 text-sm text-slate-300">
                      <Icon name={method.icon} size={18} className="text-secondary-light" />
                      {method.label}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <HashText value={entry.txHash} label="hash transaksi" className="text-secondary-light" />
                    <p className="mt-0.5 font-mono text-[11px] text-slate-500">Blok #{formatNumber(entry.blockNumber)}</p>
                  </td>
                  <td className="px-5 py-3.5">
                    <SyncBadge mode={entry.syncMode} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-3 p-3 md:hidden">
        {entries.map((entry) => {
          const offline = entry.syncMode === 'offline';
          return (
            <li key={entry.id} className={cx('inset-well flex flex-col gap-3 p-4', offline && 'ring-1 ring-tertiary/30')}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <TimeCell entry={entry} now={now} />
                </div>
                <SyncBadge mode={entry.syncMode} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <RoomTag roomId={entry.roomId} offline={offline} />
                <DirectionBadge direction={entry.direction} />
              </div>
              <p className="text-sm font-semibold text-slate-100">
                {entry.name} <span className="font-normal text-slate-400">• {METHOD[entry.method].label}</span>
              </p>
              <HashText value={entry.txHash} label="hash transaksi" className="text-secondary-light" />
            </li>
          );
        })}
      </ul>
    </>
  );
}
