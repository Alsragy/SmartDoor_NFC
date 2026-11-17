import { DASHBOARD_OPERATOR } from '../../config/constants';
import { useDormChainState } from '../../context/DormChainContext';
import { cx } from '../../utils/cx';
import { formatNumber } from '../../utils/format';
import { InternetToggle } from '../simulation/InternetToggle';

export function Topbar() {
  const { internetOnline, ledger } = useDormChainState();
  const initials = DASHBOARD_OPERATOR.name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2);

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-white/6 bg-surface/90 px-4 backdrop-blur-xl md:px-8">
      <div className="flex min-w-0 items-center gap-3">
        <div className="hidden items-center gap-2.5 rounded-full border border-white/8 bg-canvas px-3 py-1.5 font-mono text-xs lg:flex">
          <span className={cx('size-2 rounded-full', internetOnline ? 'animate-pulse bg-primary-light' : 'bg-critical-light')} />
          <span className="font-bold text-slate-200">{ledger.network}</span>
          <span className="text-slate-600">•</span>
          <span className="text-secondary-light">#{formatNumber(ledger.blockNumber)}</span>
          <span className="text-slate-600">•</span>
          <span className="text-slate-400">{internetOnline ? `Ping ${ledger.pingMs}ms` : 'RPC terputus'}</span>
        </div>
        <InternetToggle />
      </div>

      <div className="flex items-center gap-3">
        <div className="hidden text-right sm:block">
          <p className="text-sm font-semibold text-white">{DASHBOARD_OPERATOR.name}</p>
          <p className="text-[11px] text-slate-400">
            {DASHBOARD_OPERATOR.role} • {DASHBOARD_OPERATOR.property}
          </p>
        </div>
        <span className="flex size-9 items-center justify-center rounded-full border border-primary/40 bg-primary/10 font-mono text-xs font-bold text-primary-light">
          {initials}
        </span>
      </div>
    </header>
  );
}
