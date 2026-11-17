import { cx } from '../../utils/cx';
import { Icon } from './Icon';

const VALUE_TONES = {
  default: 'text-white',
  success: 'text-primary-light',
  info: 'text-secondary-light',
  warning: 'text-tertiary-light',
  critical: 'text-critical-light',
};

/** Kartu metrik ringkasan: label, badge opsional, nilai utama, dan konten footer. */
export function StatCard({ label, icon, badge, value, unit, tone = 'default', glow, children }) {
  return (
    <article className={cx('panel flex flex-col gap-4 p-5', glow)}>
      <div className="flex items-start justify-between gap-3">
        <p className="eyebrow max-w-[60%]">{label}</p>
        {badge ?? (icon && <Icon name={icon} size={22} className="text-secondary-light" />)}
      </div>
      <p className="flex items-baseline gap-2">
        <span className={cx('font-display text-headline-xl', VALUE_TONES[tone])}>{value}</span>
        {unit && <span className="text-sm text-slate-400">{unit}</span>}
      </p>
      {children && <div className="mt-auto">{children}</div>}
    </article>
  );
}
