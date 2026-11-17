import { formatTime } from '../../utils/format';
import { cx } from '../../utils/cx';
import { Icon } from '../ui/Icon';
import { Panel, PanelHeader } from '../ui/Panel';
import { StatusChip } from '../ui/StatusChip';

const METHOD_ICON = { nfc: 'contactless', remote: 'settings_remote', sensor: 'sensors' };

/** Aliran ringkas log audit terbaru. */
export function AuditStream({ entries, limit = 6 }) {
  return (
    <Panel>
      <PanelHeader
        icon="stream"
        iconClassName="text-secondary-light"
        title="Audit Stream Terakhir"
        action={
          <StatusChip tone="info" dot pulse>
            Live
          </StatusChip>
        }
      />
      <ul className="flex flex-col gap-2">
        {entries.slice(0, limit).map((entry) => {
          const offline = entry.syncMode === 'offline';
          return (
            <li key={entry.id} className={cx('inset-well flex gap-3 p-3', offline && 'ring-1 ring-tertiary/30')}>
              <Icon name={METHOD_ICON[entry.method]} size={18} className={offline ? 'text-tertiary-light' : 'text-primary-light'} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-100">
                  Kamar {entry.roomId} • {entry.direction === 'in' ? 'Masuk' : 'Keluar'}
                </p>
                <p className="truncate text-xs text-slate-400">{entry.name}</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className={cx('font-mono text-label-mono-sm', offline ? 'text-tertiary-light' : 'text-slate-400')}>
                  {formatTime(entry.eventAt)}
                </span>
                {offline && <span className="font-mono text-[10px] text-tertiary-light">susulan</span>}
              </div>
            </li>
          );
        })}
      </ul>
      <a href="#/audit" className="mt-3 flex items-center justify-center gap-1 text-xs font-semibold text-secondary-light hover:underline">
        Lihat ledger audit lengkap <Icon name="arrow_forward" size={14} />
      </a>
    </Panel>
  );
}
