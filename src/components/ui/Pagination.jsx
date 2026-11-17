import { cx } from '../../utils/cx';
import { Button } from './Button';

export function Pagination({ page, pageCount, onChange }) {
  if (pageCount <= 1) return null;
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);

  return (
    <nav aria-label="Navigasi halaman" className="flex items-center gap-1.5">
      <Button size="sm" icon="chevron_left" disabled={page === 1} onClick={() => onChange(page - 1)}>
        Sebelumnya
      </Button>
      {pages.map((n) => (
        <button
          key={n}
          type="button"
          aria-current={n === page ? 'page' : undefined}
          onClick={() => onChange(n)}
          className={cx(
            'size-8 rounded-lg font-mono text-xs transition',
            n === page ? 'bg-primary font-bold text-on-primary' : 'text-slate-400 hover:bg-white/5',
          )}
        >
          {n}
        </button>
      ))}
      <Button size="sm" disabled={page === pageCount} onClick={() => onChange(page + 1)}>
        Berikutnya
      </Button>
    </nav>
  );
}
