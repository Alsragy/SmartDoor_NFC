import { cx } from '../../utils/cx';
import { Icon } from './Icon';

/** Container permukaan (`panel`) atau kartu telemetri kaca (`glass`). */
export function Panel({ as: Tag = 'section', glass = false, className, children, ...rest }) {
  return (
    <Tag className={cx(glass ? 'glass-card' : 'panel', 'p-5', className)} {...rest}>
      {children}
    </Tag>
  );
}

export function PanelHeader({ icon, iconClassName = 'text-primary', title, subtitle, action }) {
  return (
    <header className="mb-4 flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        {icon && <Icon name={icon} size={22} className={cx('mt-0.5', iconClassName)} />}
        <div className="min-w-0">
          <h2 className="font-display text-headline-sm text-white">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
        </div>
      </div>
      {action}
    </header>
  );
}
