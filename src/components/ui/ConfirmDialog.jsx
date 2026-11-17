import { useEffect, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { Modal } from './Modal';

/**
 * Konfirmasi untuk aksi kritis. `onConfirm` boleh async; selama berjalan
 * dialog tidak bisa ditutup, dan error ditampilkan di dalam dialog.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  details,
  confirmLabel = 'Konfirmasi',
  tone = 'primary',
  icon = tone === 'destructive' ? 'gpp_maybe' : 'lock_open',
  onConfirm,
  onClose,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setBusy(false);
      setError('');
    }
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err?.message ?? 'Aksi gagal dijalankan.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={title}
      icon={icon}
      iconTone={tone === 'destructive' ? 'text-critical-light' : 'text-primary-light'}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button variant={tone} onClick={confirm} loading={busy} autoFocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-300">{description}</p>
      {details && <div className="mt-4 inset-well p-4">{details}</div>}
      {error && (
        <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg bg-critical/10 p-3 text-sm text-critical-light">
          <Icon name="error" size={18} />
          {error}
        </p>
      )}
    </Modal>
  );
}
