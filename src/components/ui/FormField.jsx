import { cloneElement, useId } from 'react';

/** Label + kontrol + pesan error/hint yang terhubung via aria-*. */
export function FormField({ label, error, hint, children }) {
  const id = useId();
  const messageId = `${id}-msg`;
  const control = cloneElement(children, {
    id,
    'aria-invalid': error ? 'true' : undefined,
    'aria-describedby': error || hint ? messageId : undefined,
  });

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-slate-300">
        {label}
      </label>
      {control}
      {(error || hint) && (
        <p id={messageId} className={error ? 'text-xs text-critical-light' : 'text-xs text-slate-500'}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
