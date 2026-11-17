import { useDormChainState } from '../../context/DormChainContext';
import { formatTime } from '../../utils/format';
import { Icon } from '../ui/Icon';
import { Panel, PanelHeader } from '../ui/Panel';
import { StatusChip } from '../ui/StatusChip';

const REASON_LABEL = { internet: 'Internet OFF', node: 'Node luring' };

/** Antrean store-and-forward ESP32 yang belum tercatat di ledger. */
export function LocalQueuePanel({ limit = 6 }) {
  const { localQueue, ledger } = useDormChainState();
  const items = [...localQueue].reverse().slice(0, limit);

  return (
    <Panel>
      <PanelHeader
        icon="inventory_2"
        iconClassName="text-tertiary-light"
        title="Antrean Lokal ESP32"
        subtitle="Event luring menunggu sinkronisasi ke Polygon L2"
        action={<StatusChip tone={localQueue.length ? 'warning' : 'success'}>{localQueue.length} event</StatusChip>}
      />
      {items.length === 0 ? (
        <p className="inset-well flex items-center gap-2 p-3 text-xs text-slate-400">
          <Icon name="task_alt" size={16} className="text-primary-light" />
          {ledger.lastFlush
            ? `Kosong. Sinkronisasi terakhir: ${ledger.lastFlush.count} event pukul ${formatTime(ledger.lastFlush.at)}.`
            : 'Kosong. Semua event sudah tercatat di ledger.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((event) => (
            <li key={event.id} className="inset-well flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-100">
                  Kamar {event.roomId} • {event.direction === 'in' ? 'Masuk' : 'Keluar'}
                </p>
                <p className="truncate text-xs text-slate-400">{event.name}</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="font-mono text-label-mono-sm text-tertiary-light">{formatTime(event.eventAt)}</span>
                <span className="font-mono text-[10px] text-slate-500">{REASON_LABEL[event.reason]}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {localQueue.length > limit && (
        <p className="mt-2 text-center font-mono text-[11px] text-slate-500">+{localQueue.length - limit} event lainnya</p>
      )}
    </Panel>
  );
}
