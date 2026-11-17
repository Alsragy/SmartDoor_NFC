import { useEffect, useState } from 'react';
import { cx } from '../../utils/cx';
import { truncateMiddle } from '../../utils/format';
import { Icon } from './Icon';

/** Hash/UID monospace dengan potongan tengah dan tombol salin. */
export function HashText({ value, head = 6, tail = 4, className, label = 'hash' }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <span className={cx('inline-flex items-center gap-1.5 font-mono text-label-mono-md', className)}>
      <span title={value}>{truncateMiddle(value, head, tail)}</span>
      <button
        type="button"
        onClick={copy}
        className="text-slate-500 transition hover:text-secondary-light"
        aria-label={copied ? `${label} tersalin` : `Salin ${label}`}
        title={copied ? 'Tersalin' : 'Salin'}
      >
        <Icon name={copied ? 'check' : 'content_copy'} size={14} className={copied ? 'text-primary-light' : undefined} />
      </button>
    </span>
  );
}
