import { cx } from '../../utils/cx';
import { Icon } from './Icon';

const TONES = {
  success: { chip: 'bg-primary/12 text-primary-light', dot: 'bg-primary-light' },
  info: { chip: 'bg-secondary/12 text-secondary-light', dot: 'bg-secondary-light' },
  warning: { chip: 'bg-tertiary/12 text-tertiary-light', dot: 'bg-tertiary-light' },
  critical: { chip: 'bg-critical/15 text-critical-light', dot: 'bg-critical-light' },
  neutral: { chip: 'bg-white/5 text-slate-400', dot: 'bg-slate-500' },
};

/** Chip status berbentuk pil (khusus metadata status, bukan tombol). */
export function StatusChip({ tone = 'neutral', dot = false, pulse = false, icon, children, className }) {
  const style = TONES[tone] ?? TONES.neutral;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-label-mono-sm whitespace-nowrap uppercase',
        style.chip,
        className,
      )}
    >
      {dot && <span className={cx('size-1.5 rounded-full', style.dot, pulse && 'animate-pulse')} />}
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}
