import { cx } from '../../utils/cx';

const TONES = {
  success: 'bg-primary shadow-glow-primary',
  info: 'bg-secondary shadow-glow-secondary',
  warning: 'bg-tertiary',
  critical: 'bg-critical',
};

export function ProgressBar({ value, tone = 'success', label, className }) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cx('h-1.5 w-full overflow-hidden rounded-full bg-canvas', className)}
    >
      <div className={cx('h-full rounded-full transition-[width] duration-500', TONES[tone])} style={{ width: `${clamped}%` }} />
    </div>
  );
}
