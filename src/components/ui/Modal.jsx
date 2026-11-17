import { useEffect, useId, useRef } from 'react';
import { cx } from '../../utils/cx';
import { Icon } from './Icon';

/**
 * Modal berbasis <dialog> native: fokus terkunci, Escape, dan backdrop
 * ditangani browser. `dismissible=false` mencegah tutup saat proses berjalan.
 */
export function Modal({ open, onClose, title, icon, iconTone = 'text-secondary-light', dismissible = true, size = 'md', children, footer }) {
  const ref = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const requestClose = () => {
    if (dismissible) onClose?.();
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) requestClose();
      }}
      className={cx(
        'm-auto w-[calc(100%-2rem)] rounded-2xl border border-white/12 bg-surface-modal p-0 text-slate-200 shadow-modal',
        'backdrop:bg-black/65 backdrop:backdrop-blur-sm open:animate-fade-in',
        size === 'lg' ? 'max-w-2xl' : 'max-w-md',
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-start gap-3 border-b border-white/6 px-6 py-5">
            {icon && <Icon name={icon} size={24} className={cx('mt-0.5', iconTone)} />}
            <h2 id={titleId} className="flex-1 font-display text-headline-md text-white">
              {title}
            </h2>
            {dismissible && (
              <button
                type="button"
                onClick={requestClose}
                className="rounded-md p-1 text-slate-500 hover:bg-white/5 hover:text-slate-200"
                aria-label="Tutup"
              >
                <Icon name="close" size={20} />
              </button>
            )}
          </header>
          <div className="overflow-y-auto px-6 py-5">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-white/6 px-6 py-4">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
