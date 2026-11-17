import { useEffect, useRef } from 'react';
import { sanitizeSearch } from '../../utils/sanitize';
import { cx } from '../../utils/cx';
import { Icon } from './Icon';

/** Input pencarian ber-sanitasi dengan hotkey Ctrl/⌘ + K. */
export function SearchInput({ value, onChange, placeholder, label, className }) {
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <label className={cx('relative block', className)}>
      <span className="sr-only">{label}</span>
      <Icon name="search" size={18} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-placeholder" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        maxLength={64}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        onChange={(event) => onChange(sanitizeSearch(event.target.value))}
        className="field h-10 pr-14 pl-9 text-sm"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded border border-white/10 bg-surface-card px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
        Ctrl K
      </kbd>
    </label>
  );
}
