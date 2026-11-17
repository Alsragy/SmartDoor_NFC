import { NAV_ITEMS } from '../../config/navigation';
import { useDormChainState } from '../../context/DormChainContext';
import { cx } from '../../utils/cx';
import { formatNumber } from '../../utils/format';
import { Icon } from '../ui/Icon';
import { ProgressBar } from '../ui/ProgressBar';

/**
 * Navigasi kiri: rail penuh 260px di desktop (xl), dock ikon di tablet (md),
 * disembunyikan di mobile (diganti MobileNav).
 */
export function Sidebar({ route }) {
  const { internetOnline, localQueue, ledger } = useDormChainState();

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-20 flex-col justify-between border-r border-white/6 bg-surface p-3 md:flex xl:w-65 xl:p-5">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col items-center gap-1.5 xl:items-start">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-primary-light shadow-glow-primary">
              <Icon name="hub" size={22} />
            </span>
            <span className="hidden font-display text-xl font-bold tracking-tight text-white xl:inline">DormChain</span>
          </div>
          <span className="hidden pl-1 font-mono text-[11px] tracking-wider text-slate-500 xl:inline">IOT • LEDGER V2.4</span>
        </div>

        <div
          className="flex items-center justify-center gap-2 rounded-xl border border-white/6 bg-canvas px-3 py-2 font-mono text-xs xl:justify-start"
          title={internetOnline ? 'Gateway online' : 'Gateway luring'}
        >
          <span className={cx('size-2 shrink-0 rounded-full', internetOnline ? 'animate-pulse bg-primary-light' : 'bg-critical-light')} />
          <span className="hidden truncate text-slate-300 xl:inline">
            ESP32 Mesh Gateway • {internetOnline ? 'Online' : 'Luring'}
          </span>
        </div>

        <nav aria-label="Navigasi utama" className="flex flex-col gap-1.5">
          {NAV_ITEMS.map((item) => {
            const active = item.route === route;
            return (
              <a
                key={item.route}
                href={`#/${item.route}`}
                aria-current={active ? 'page' : undefined}
                title={item.label}
                className={cx(
                  'flex items-center justify-center gap-3 rounded-xl px-3.5 py-2.5 text-sm transition xl:justify-start',
                  active
                    ? 'border border-primary/30 bg-primary/12 font-semibold text-primary-light shadow-glow-primary'
                    : 'border border-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200',
                )}
              >
                <Icon name={item.icon} size={20} />
                <span className="hidden xl:inline">{item.label}</span>
              </a>
            );
          })}
        </nav>
      </div>

      <div className="hidden flex-col gap-2.5 rounded-xl border border-white/6 bg-canvas p-3.5 xl:flex">
        <div className="flex items-center justify-between font-mono text-xs">
          <span className="flex items-center gap-2 text-slate-400">
            <Icon name="lock" size={16} className="text-secondary-light" />
            Smart Contract Sync
          </span>
          <span className={internetOnline ? 'font-bold text-primary-light' : 'font-bold text-tertiary-light'}>
            {internetOnline ? '99.98%' : 'Tertunda'}
          </span>
        </div>
        <ProgressBar value={internetOnline ? 99.98 : 62} tone={internetOnline ? 'success' : 'warning'} label="Sinkronisasi smart contract" />
        <div className="flex items-center justify-between font-mono text-[11px] text-slate-500">
          {localQueue.length > 0 ? (
            <span className="text-tertiary-light">Antrean lokal: {localQueue.length}</span>
          ) : (
            <span className="flex items-center gap-1.5 text-secondary-light">
              <span className="size-1.5 rounded-full bg-secondary-light" />
              Synced
            </span>
          )}
          <span className="text-slate-400">Block #{formatNumber(ledger.blockNumber)}</span>
        </div>
      </div>
    </aside>
  );
}

export function MobileNav({ route }) {
  return (
    <nav
      aria-label="Navigasi utama"
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-white/8 bg-surface/95 backdrop-blur-xl md:hidden"
    >
      {NAV_ITEMS.map((item) => {
        const active = item.route === route;
        return (
          <a
            key={item.route}
            href={`#/${item.route}`}
            aria-current={active ? 'page' : undefined}
            className={cx(
              'flex flex-col items-center gap-1 py-2.5 text-[11px]',
              active ? 'text-primary-light' : 'text-slate-500',
            )}
          >
            <Icon name={item.icon} size={22} filled={active} />
            {item.shortLabel}
          </a>
        );
      })}
    </nav>
  );
}
