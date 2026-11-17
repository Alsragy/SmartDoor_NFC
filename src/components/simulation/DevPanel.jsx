import { useMemo, useState } from 'react';
import { useDormChainState } from '../../context/DormChainContext';
import { useSimulationControls } from '../../hooks/useSimulationControls';
import { selectRoomViews } from '../../services/selectors';
import { cx } from '../../utils/cx';
import { sanitizeEnum } from '../../utils/sanitize';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Switch } from '../ui/Switch';

/** Panel developer mengambang untuk mengendalikan simulasi. */
export function DevPanel() {
  const state = useDormChainState();
  const { available, setInternet, simulateTap, setAutoTraffic, reset } = useSimulationControls();
  const [open, setOpen] = useState(false);
  const rooms = useMemo(() => selectRoomViews(state).filter((r) => r.resident || r.admins.length), [state]);
  const [roomId, setRoomId] = useState('');

  if (!available) return null;
  const roomIds = rooms.map((r) => r.roomId);
  const selectedRoom = sanitizeEnum(roomId, roomIds, roomIds[0] ?? '');

  return (
    <div className="fixed right-4 bottom-20 z-50 flex flex-col items-end gap-3 md:bottom-6">
      {open && (
        <section
          id="dev-panel"
          aria-label="Panel developer simulasi"
          className="w-80 animate-fade-in rounded-3xl border border-white/12 bg-surface-modal p-5 shadow-modal"
        >
          <header className="mb-4 flex items-center justify-between">
            <p className="font-mono text-label-mono-sm tracking-[0.12em] text-secondary-light uppercase">Panel Developer</p>
            <span className="rounded-full bg-secondary/12 px-2 py-0.5 font-mono text-[10px] text-secondary-light">MOCK</span>
          </header>

          <div className="flex flex-col gap-3 text-sm">
            <label className="flex items-center justify-between gap-3">
              <span>
                Simulasi Internet: <strong className="font-mono">{state.internetOnline ? 'ON' : 'OFF'}</strong>
              </span>
              <Switch checked={state.internetOnline} onChange={setInternet} label="Simulasi internet" />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span>Lalu lintas tap otomatis</span>
              <Switch checked={state.autoTraffic} onChange={setAutoTraffic} tone="info" label="Lalu lintas tap otomatis" />
            </label>

            <div className="inset-well mt-1 flex flex-col gap-2 p-3">
              <label htmlFor="dev-tap-room" className="text-xs text-slate-400">
                Simulasikan tap kartu NFC di pintu
              </label>
              <div className="flex gap-2">
                <select
                  id="dev-tap-room"
                  value={selectedRoom}
                  onChange={(e) => setRoomId(sanitizeEnum(e.target.value, roomIds))}
                  className="field h-8 flex-1 px-2 text-xs"
                >
                  {rooms.map((r) => (
                    <option key={r.roomId} value={r.roomId}>
                      {r.roomId} - {(r.resident ?? r.admins[0]).name}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="info" icon="contactless" disabled={!selectedRoom} onClick={() => simulateTap(selectedRoom)}>
                  Tap
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between font-mono text-xs text-slate-400">
              <span>Antrean lokal</span>
              <span className={state.localQueue.length ? 'text-tertiary-light' : 'text-primary-light'}>
                {state.localQueue.length} event
              </span>
            </div>

            <Button size="sm" variant="ghost" icon="restart_alt" onClick={reset}>
              Reset data simulasi
            </Button>
          </div>
        </section>
      )}

      <button
        type="button"
        aria-expanded={open}
        aria-controls="dev-panel"
        onClick={() => setOpen((v) => !v)}
        className={cx(
          'flex size-12 items-center justify-center rounded-full border shadow-modal transition',
          'focus-visible:ring-2 focus-visible:ring-secondary focus-visible:outline-none',
          open ? 'border-secondary/50 bg-secondary/20 text-secondary-light' : 'border-white/12 bg-surface-modal text-slate-300 hover:text-white',
        )}
        title="Panel developer simulasi"
      >
        <Icon name={open ? 'close' : 'developer_mode'} size={22} />
      </button>
    </div>
  );
}
