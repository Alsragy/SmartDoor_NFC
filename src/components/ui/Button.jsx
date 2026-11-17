import { cx } from '../../utils/cx';
import { Icon } from './Icon';

const VARIANTS = {
  primary: 'bg-primary text-on-primary hover:brightness-110 hover:shadow-glow-primary',
  secondary: 'border border-white/15 text-slate-100 hover:bg-white/5',
  destructive: 'bg-critical text-white hover:shadow-glow-critical',
  warning: 'border border-tertiary/40 bg-tertiary/10 text-tertiary-light hover:bg-tertiary/20',
  info: 'border border-secondary/30 bg-secondary/10 text-secondary-light hover:bg-secondary/20',
  ghost: 'text-slate-400 hover:bg-white/5 hover:text-slate-100',
  dangerGhost: 'text-critical-light hover:bg-critical/10',
};

const SIZES = {
  sm: 'h-8 gap-1.5 px-3 text-xs',
  md: 'h-10 gap-2 px-4 text-sm',
  icon: 'h-9 w-9',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-semibold whitespace-nowrap transition',
        'focus-visible:ring-2 focus-visible:ring-secondary focus-visible:outline-none',
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Icon name="progress_activity" size={size === 'sm' ? 14 : 18} className="animate-spin" />
      ) : (
        icon && <Icon name={icon} size={size === 'sm' ? 14 : 18} />
      )}
      {children}
    </button>
  );
}
