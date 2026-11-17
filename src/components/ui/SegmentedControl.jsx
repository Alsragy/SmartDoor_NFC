import { cx } from '../../utils/cx';

/**
 * Grup tombol pilihan tunggal.
 * @param {{ options: { value: string, label: import('react').ReactNode }[], value: string, onChange: (v: string) => void, label: string }} props
 */
export function SegmentedControl({ options, value, onChange, label, className }) {
  return (
    <div role="radiogroup" aria-label={label} className={cx('inline-flex rounded-lg border border-white/8 bg-canvas p-1', className)}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition',
              'focus-visible:ring-2 focus-visible:ring-secondary focus-visible:outline-none',
              selected ? 'bg-surface-card font-semibold text-white' : 'text-slate-400 hover:text-slate-200',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
