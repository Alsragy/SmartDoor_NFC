import { cx } from '../../utils/cx';

export function PageHeader({ eyebrow, eyebrowTone = 'success', title, description, actions }) {
  return (
    <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
      <div className="max-w-3xl">
        <p
          className={cx(
            'flex items-center gap-2 font-mono text-label-mono-sm font-semibold tracking-[0.12em] uppercase',
            eyebrowTone === 'warning' ? 'text-tertiary-light' : 'text-primary-light',
          )}
        >
          <span className={cx('size-2 rounded-full', eyebrowTone === 'warning' ? 'bg-tertiary-light' : 'animate-pulse bg-primary-light')} />
          {eyebrow}
        </p>
        <h1 className="mt-2 font-display text-headline-lg text-white md:text-headline-xl">{title}</h1>
        {description && <p className="mt-2 text-sm text-slate-400 md:text-base">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}
