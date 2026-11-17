import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/ui/Icon';
import { cx } from '../utils/cx';

const ToastContext = createContext(null);
const DISMISS_MS = 5000;

const TONES = {
  success: { icon: 'verified', className: 'border-primary/30 text-primary-light' },
  info: { icon: 'info', className: 'border-secondary/30 text-secondary-light' },
  warning: { icon: 'warning', className: 'border-tertiary/30 text-tertiary-light' },
  critical: { icon: 'error', className: 'border-critical/40 text-critical-light' },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const notify = useCallback(
    ({ tone = 'info', title, message }) => {
      const id = ++nextId.current;
      setToasts((list) => [...list.slice(-3), { id, tone, title, message }]);
      setTimeout(() => dismiss(id), DISMISS_MS);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed top-20 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((toast) => {
          const tone = TONES[toast.tone] ?? TONES.info;
          return (
            <div
              key={toast.id}
              role="status"
              className={cx(
                'pointer-events-auto flex animate-fade-in gap-3 rounded-xl border bg-surface-modal p-3.5 shadow-modal',
                tone.className,
              )}
            >
              <Icon name={tone.icon} size={20} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-100">{toast.title}</p>
                {toast.message && <p className="mt-0.5 break-words text-xs text-slate-400">{toast.message}</p>}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="self-start text-slate-500 hover:text-slate-200"
                aria-label="Tutup notifikasi"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast harus dipakai di dalam <ToastProvider>.');
  return ctx;
}
