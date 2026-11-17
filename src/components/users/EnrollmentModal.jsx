import { useEffect, useRef, useState } from 'react';
import { ENROLLMENT_TIMEOUT_SECONDS, ROLES, ROLE_VALUES } from '../../config/constants';
import { useDataSource, useDormChainState } from '../../context/DormChainContext';
import { useToast } from '../../context/ToastContext';
import { useCountdown } from '../../hooks/useCountdown';
import { isoDateFromNow } from '../../utils/format';
import {
  sanitizeDate,
  sanitizeEnum,
  sanitizeName,
  sanitizePhone,
  validateEnrollmentForm,
} from '../../utils/sanitize';
import { Button } from '../ui/Button';
import { DetailList } from '../ui/DetailList';
import { FormField } from '../ui/FormField';
import { HashText } from '../ui/HashText';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';
import { SegmentedControl } from '../ui/SegmentedControl';
import { CountdownRing } from './CountdownRing';

const EMPTY_FORM = { name: '', phone: '', roomId: '', role: 'resident', validUntil: '' };
const ROLE_OPTIONS = ROLE_VALUES.map((value) => ({ value, label: ROLES[value].label }));

/**
 * Alur pendaftaran kartu NFC:
 * form -> waiting (hitung mundur 30 dtk menunggu ESP32) -> registering -> success
 * dengan cabang timeout / error yang bisa diulang.
 */
export function EnrollmentModal({ open, onClose }) {
  const dataSource = useDataSource();
  const { roomIds, internetOnline } = useDormChainState();
  const { notify } = useToast();

  const [step, setStep] = useState('form');
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState(null);
  const [failure, setFailure] = useState('');
  const abortRef = useRef(null);

  const remaining = useCountdown(ENROLLMENT_TIMEOUT_SECONDS, { active: step === 'waiting', resetKey: attempt });

  useEffect(() => {
    if (open) {
      setStep('form');
      setForm({ ...EMPTY_FORM, validUntil: isoDateFromNow(180) });
      setErrors({});
      setResult(null);
      setFailure('');
    }
    return () => abortRef.current?.abort();
  }, [open]);

  const quotaFor = (roomId, role) => dataSource.getQuota(roomId, role);
  const isRoomFull = (roomId, role) => {
    const { used, limit } = quotaFor(roomId, role);
    return used >= limit;
  };

  const setField = (field, value) => {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  };

  /** Payload final yang sudah disanitasi penuh. */
  const cleanPayload = () => ({
    name: sanitizeName(form.name),
    phone: sanitizePhone(form.phone),
    roomId: sanitizeEnum(form.roomId, roomIds),
    role: sanitizeEnum(form.role, ROLE_VALUES, 'resident'),
    validUntil: sanitizeDate(form.validUntil),
  });

  const startWaiting = async (payload) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setAttempt((n) => n + 1);
    setFailure('');
    setStep('waiting');

    try {
      const { uid } = await dataSource.waitForCardTap({
        timeoutMs: ENROLLMENT_TIMEOUT_SECONDS * 1000,
        signal: controller.signal,
      });
      setStep('registering');
      const credential = await dataSource.registerCredential(payload, uid);
      setResult(credential);
      setStep('success');
      notify({ tone: 'success', title: 'Kartu NFC terdaftar', message: `${credential.name} • Kamar ${credential.roomId}` });
    } catch (error) {
      if (error.code === 'ABORTED') return;
      setFailure(error.message);
      setStep(error.code === 'TIMEOUT' ? 'timeout' : 'error');
    }
  };

  const submit = (event) => {
    event.preventDefault();
    const payload = cleanPayload();
    const nextErrors = validateEnrollmentForm(payload, { roomIds, roleValues: ROLE_VALUES });
    if (payload.roomId && isRoomFull(payload.roomId, payload.role)) {
      const { used, limit } = quotaFor(payload.roomId, payload.role);
      nextErrors.roomId = `Kuota ${ROLES[payload.role].label} kamar ini penuh (${used}/${limit}).`;
    }
    setForm(payload);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) startWaiting(payload);
  };

  const cancelWaiting = () => {
    abortRef.current?.abort();
    setStep('form');
  };

  const close = () => {
    abortRef.current?.abort();
    onClose();
  };

  const busy = step === 'registering';

  return (
    <Modal
      open={open}
      onClose={close}
      dismissible={!busy}
      size="lg"
      title="Daftarkan Kartu NFC Baru"
      icon="add_card"
      iconTone="text-primary-light"
    >
      {step === 'form' && (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          {!internetOnline && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-tertiary/10 p-3 text-xs text-tertiary-light">
              <Icon name="cloud_off" size={16} />
              Internet OFF: kartu tidak dapat dicatat ke smart contract sampai koneksi pulih.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Nama lengkap" error={errors.name}>
              <input
                type="text"
                value={form.name}
                maxLength={60}
                autoComplete="off"
                onChange={(e) => setField('name', sanitizeName(e.target.value, { trim: false }))}
                placeholder="Contoh: Budi Santoso"
                className="field h-10 px-3 text-sm"
              />
            </FormField>
            <FormField label="Nomor telepon" error={errors.phone}>
              <input
                type="tel"
                inputMode="tel"
                value={form.phone}
                maxLength={20}
                autoComplete="off"
                onChange={(e) => setField('phone', sanitizePhone(e.target.value, { trim: false }))}
                placeholder="+62 812-3456-7890"
                className="field h-10 px-3 font-mono text-sm"
              />
            </FormField>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-slate-300">Tipe kredensial</span>
            <SegmentedControl
              label="Tipe kredensial"
              options={ROLE_OPTIONS}
              value={form.role}
              onChange={(value) => setField('role', sanitizeEnum(value, ROLE_VALUES, 'resident'))}
              className="self-start"
            />
            <p className="text-xs text-slate-500">Batas per pintu: 1 Penghuni dan 2 Admin Pengelola.</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Kamar / node pintu" error={errors.roomId}>
              <select
                value={form.roomId}
                onChange={(e) => setField('roomId', sanitizeEnum(e.target.value, roomIds))}
                className="field h-10 px-3 text-sm"
              >
                <option value="">Pilih kamar</option>
                {roomIds.map((roomId) => {
                  const { used, limit } = quotaFor(roomId, form.role);
                  return (
                    <option key={roomId} value={roomId} disabled={used >= limit}>
                      Kamar {roomId} • {ROLES[form.role].label} {used}/{limit}
                      {used >= limit ? ' (penuh)' : ''}
                    </option>
                  );
                })}
              </select>
            </FormField>
            <FormField label="Masa berlaku hingga" error={errors.validUntil}>
              <input
                type="date"
                value={form.validUntil}
                min={isoDateFromNow(1)}
                max={isoDateFromNow(730)}
                onChange={(e) => setField('validUntil', sanitizeDate(e.target.value))}
                className="field h-10 px-3 font-mono text-sm [color-scheme:dark]"
              />
            </FormField>
          </div>

          <div className="flex justify-end gap-2 border-t border-white/6 pt-4">
            <Button onClick={close}>Batal</Button>
            <Button type="submit" variant="primary" icon="contactless" disabled={!internetOnline}>
              Tambah Kartu
            </Button>
          </div>
        </form>
      )}

      {step === 'waiting' && (
        <div className="flex flex-col items-center gap-5 py-2 text-center">
          <CountdownRing remaining={remaining} total={ENROLLMENT_TIMEOUT_SECONDS} />
          <div>
            <p className="flex items-center justify-center gap-2 font-semibold text-white">
              <Icon name="contactless" size={20} className="animate-pulse text-secondary-light" />
              Menunggu kartu ditempel pada reader...
            </p>
            <p className="mt-1 text-sm text-slate-400">
              Letakkan kartu MIFARE pada reader USB ESP32 (COM4). Kartu untuk <strong className="text-slate-200">{form.name}</strong>, Kamar{' '}
              <span className="font-mono text-secondary-light">{form.roomId}</span>.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={cancelWaiting}>Batalkan</Button>
            {dataSource.capabilities?.simulation && (
              <Button variant="primary" icon="touch_app" onClick={() => dataSource.simulateCardTap()}>
                Simulasikan Tap Sukses
              </Button>
            )}
          </div>
        </div>
      )}

      {step === 'registering' && (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <Icon name="progress_activity" size={40} className="animate-spin text-secondary-light" />
          <p className="font-semibold text-white">Kartu terbaca. Menulis kredensial ke smart contract...</p>
          <p className="text-sm text-slate-400">Hash UID SHA-256 dikirim ke Polygon L2. Jangan tutup jendela ini.</p>
        </div>
      )}

      {step === 'success' && result && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/10 p-4 shadow-glow-primary">
            <Icon name="verified" size={28} className="text-primary-light" filled />
            <div>
              <p className="font-semibold text-primary-light">Kredensial aktif</p>
              <p className="text-sm text-slate-300">Node Kamar {result.roomId} akan menerima whitelist baru pada sinkronisasi berikutnya.</p>
            </div>
          </div>
          <div className="inset-well p-4">
            <DetailList
              items={[
                ['Pengguna', result.name],
                ['Tipe', ROLES[result.role].label],
                ['UID kartu', result.uid],
                ['UID hash', <HashText key="h" value={result.uidHash} head={8} tail={6} label="hash UID" />],
                ['Tx hash', <HashText key="t" value={result.txHash} head={10} tail={6} label="hash transaksi" className="text-secondary-light" />],
              ]}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                setForm({ ...EMPTY_FORM, validUntil: isoDateFromNow(180) });
                setStep('form');
              }}
            >
              Daftarkan Lagi
            </Button>
            <Button variant="primary" onClick={close}>
              Selesai
            </Button>
          </div>
        </div>
      )}

      {(step === 'timeout' || step === 'error') && (
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <Icon
            name={step === 'timeout' ? 'timer_off' : 'error'}
            size={40}
            className={step === 'timeout' ? 'text-tertiary-light' : 'text-critical-light'}
          />
          <div>
            <p className="font-semibold text-white">{step === 'timeout' ? 'Waktu tunggu habis' : 'Pendaftaran gagal'}</p>
            <p className="mt-1 text-sm text-slate-400">{failure}</p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setStep('form')}>Ubah Data</Button>
            <Button variant="primary" icon="refresh" onClick={() => startWaiting(cleanPayload())}>
              Coba Lagi
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
