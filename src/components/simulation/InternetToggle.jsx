import { useDormChainState } from '../../context/DormChainContext';
import { useSimulationControls } from '../../hooks/useSimulationControls';
import { cx } from '../../utils/cx';
import { Icon } from '../ui/Icon';

/** Tombol global "Simulasi Internet: ON/OFF". */
export function InternetToggle() {
  const { internetOnline, localQueue } = useDormChainState();
  const { available, setInternet } = useSimulationControls();
  if (!available) return null;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={internetOnline}
      onClick={() => setInternet(!internetOnline)}
      className={cx(
        'inline-flex h-9 items-center gap-2 rounded-lg border px-3 font-mono text-xs font-semibold transition',
        'focus-visible:ring-2 focus-visible:ring-secondary focus-visible:outline-none',
        internetOnline
          ? 'border-primary/30 bg-primary/10 text-primary-light hover:bg-primary/15'
          : 'border-critical/40 bg-critical/12 text-critical-light shadow-glow-critical hover:bg-critical/20',
      )}
    >
      <Icon name={internetOnline ? 'wifi' : 'wifi_off'} size={18} />
      <span className="hidden sm:inline">Simulasi Internet:</span>
      <span>{internetOnline ? 'ON' : 'OFF'}</span>
      {!internetOnline && localQueue.length > 0 && (
        <span className="rounded-full bg-tertiary/20 px-1.5 text-tertiary-light">{localQueue.length}</span>
      )}
    </button>
  );
}
