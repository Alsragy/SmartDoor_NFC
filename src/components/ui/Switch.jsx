import { cx } from '../../utils/cx';

export function Switch({ checked, onChange, label, tone = 'success', className }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition',
        'focus-visible:ring-2 focus-visible:ring-secondary focus-visible:outline-none',
        checked
          ? tone === 'success'
            ? 'border-primary/50 bg-primary/30'
            : 'border-secondary/50 bg-secondary/30'
          : 'border-critical/40 bg-critical/20',
        className,
      )}
    >
      <span
        className={cx(
          'size-3.5 rounded-full transition-transform',
          checked ? 'translate-x-4.5 bg-primary-light' : 'translate-x-0.5 bg-critical-light',
        )}
      />
    </button>
  );
}
