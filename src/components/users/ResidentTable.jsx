import { ROLES } from '../../config/constants';
import { cx } from '../../utils/cx';
import { daysUntil, formatIsoDate } from '../../utils/format';
import { Button } from '../ui/Button';
import { HashText } from '../ui/HashText';
import { Icon } from '../ui/Icon';
import { StatusChip } from '../ui/StatusChip';

const STATUS = {
  active: { tone: 'success', label: 'Aktif' },
  expiring: { tone: 'warning', label: 'Segera Habis' },
  expired: { tone: 'critical', label: 'Kedaluwarsa' },
  revoked: { tone: 'neutral', label: 'Dicabut' },
};

const HEADERS = ['Pengguna & Kontak', 'Kamar', 'ID Kartu (UID Hashed)', 'Tipe Kredensial', 'Kuota Pintu', 'Masa Berlaku', 'Status', 'Aksi'];

const initialsOf = (name) =>
  name
    .split(' ')
    .filter(Boolean)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

function Avatar({ name, role }) {
  return (
    <span
      className={cx(
        'flex size-9 shrink-0 items-center justify-center rounded-full border font-mono text-xs font-bold',
        role === 'admin' ? 'border-tertiary/40 bg-tertiary/10 text-tertiary-light' : 'border-primary/30 bg-primary/10 text-primary-light',
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

function ValidityCell({ credential, status, now }) {
  const days = daysUntil(credential.validUntil, now);
  return (
    <>
      <p className={cx('text-sm', status === 'expiring' ? 'font-semibold text-tertiary-light' : 'text-slate-200')}>
        {formatIsoDate(credential.validUntil)}
      </p>
      <p className="mt-0.5 font-mono text-[11px] text-slate-500">
        {status === 'revoked' ? 'Akses dicabut' : days >= 0 ? `Sisa ${days} hari` : 'Lewat masa berlaku'}
      </p>
    </>
  );
}

/**
 * Tabel penghuni & admin beserta pemakaian kuota per pintu
 * (1 Penghuni, 2 Admin per node kunci).
 *
 * @param {{ rows: { credential: object, status: string }[], quotaFor: (roomId: string, role: string) => { used: number, limit: number }, onRevoke: (c: object) => void, canRevoke: boolean, now: number }} props
 */
export function ResidentTable({ rows, quotaFor, onRevoke, canRevoke, now }) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-slate-400">
        <Icon name="person_search" size={28} />
        Tidak ada pengguna yang cocok dengan filter.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1080px] text-left">
        <thead>
          <tr className="border-b border-white/6">
            {HEADERS.map((h) => (
              <th key={h} scope="col" className="eyebrow px-5 py-4">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ credential: c, status }) => {
            const quota = quotaFor(c.roomId, c.role);
            const statusStyle = STATUS[status];
            const revoked = status === 'revoked';
            return (
              <tr
                key={c.id}
                className={cx(
                  'border-b border-white/4 transition last:border-0 hover:bg-white/2',
                  revoked && 'opacity-50',
                  status === 'expiring' && 'bg-tertiary/5',
                )}
              >
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <Avatar name={c.name} role={c.role} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-100">{c.name}</p>
                      <p className="font-mono text-[11px] text-slate-400">{c.phone}</p>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-3.5">
                  <span className="rounded-md border border-secondary/30 bg-secondary/10 px-2 py-1 font-mono text-label-mono-sm text-secondary-light">
                    KM-{c.roomId}
                  </span>
                </td>
                <td className="px-5 py-3.5">
                  <HashText value={c.uidHash} head={8} tail={4} label="hash UID" className="text-slate-200" />
                  <p className="mt-0.5 font-mono text-[10px] text-primary-light">SHA-256 • AES-128</p>
                </td>
                <td className="px-5 py-3.5">
                  <StatusChip tone={c.role === 'admin' ? 'warning' : 'success'}>{ROLES[c.role].label}</StatusChip>
                </td>
                <td className="px-5 py-3.5">
                  <p className={cx('font-mono text-label-mono-md', quota.used >= quota.limit ? 'text-slate-200' : 'text-primary-light')}>
                    {quota.used} / {quota.limit}
                  </p>
                  <p className="text-[11px] text-slate-500">{quota.used >= quota.limit ? 'Penuh' : 'Tersedia'}</p>
                </td>
                <td className="px-5 py-3.5">
                  <ValidityCell credential={c} status={status} now={now} />
                </td>
                <td className="px-5 py-3.5">
                  <StatusChip tone={statusStyle.tone} dot={!revoked}>
                    {statusStyle.label}
                  </StatusChip>
                </td>
                <td className="px-5 py-3.5">
                  {!revoked && (
                    <Button
                      size="sm"
                      variant="dangerGhost"
                      icon="person_remove"
                      disabled={!canRevoke}
                      title={canRevoke ? undefined : 'Butuh koneksi internet'}
                      onClick={() => onRevoke(c)}
                    >
                      Cabut Akses
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
