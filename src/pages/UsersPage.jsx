import { useMemo, useState } from 'react';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { DetailList } from '../components/ui/DetailList';
import { Pagination } from '../components/ui/Pagination';
import { ProgressBar } from '../components/ui/ProgressBar';
import { SearchInput } from '../components/ui/SearchInput';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { StatCard } from '../components/ui/StatCard';
import { StatusChip } from '../components/ui/StatusChip';
import { EnrollmentModal } from '../components/users/EnrollmentModal';
import { ResidentTable } from '../components/users/ResidentTable';
import { QUOTA_PER_DOOR, ROLES } from '../config/constants';
import { useDataSource, useDormChainState } from '../context/DormChainContext';
import { useToast } from '../context/ToastContext';
import { useNow } from '../hooks/useNow';
import { usePagination } from '../hooks/usePagination';
import { selectCredentialStatus, selectSummary } from '../services/selectors';
import { truncateMiddle } from '../utils/format';

const PAGE_SIZE = 8;
const ROLE_FILTERS = [
  { value: 'all', label: 'Semua Role' },
  { value: 'resident', label: 'Penghuni' },
  { value: 'admin', label: 'Admin' },
  { value: 'revoked', label: 'Dicabut' },
];

export function UsersPage() {
  const state = useDormChainState();
  const dataSource = useDataSource();
  const { notify } = useToast();
  const now = useNow();

  const [roleFilter, setRoleFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState(null);

  const summary = useMemo(() => selectSummary(state), [state]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const matchesQuery = (c) =>
      !q ||
      c.name.toLowerCase().includes(q) ||
      c.roomId.includes(q) ||
      (digits.length > 0 && c.phone.replace(/\D/g, '').includes(digits));

    return state.credentials
      .map((credential) => ({ credential, status: selectCredentialStatus(credential, now) }))
      .filter(({ credential: c, status }) => {
        if (roleFilter === 'revoked') return status === 'revoked' && matchesQuery(c);
        if (roleFilter !== 'all' && (c.role !== roleFilter || status === 'revoked')) return false;
        return matchesQuery(c);
      })
      .sort((a, b) => a.credential.roomId.localeCompare(b.credential.roomId) || a.credential.role.localeCompare(b.credential.role));
  }, [state.credentials, roleFilter, query, now]);

  const { page, pageCount, pageItems, setPage, total } = usePagination(rows, PAGE_SIZE, `${roleFilter}|${query}`);

  const quotaFor = (roomId, role) => dataSource.getQuota(roomId, role);
  const residentSlots = state.roomIds.length * QUOTA_PER_DOOR.resident;
  const adminSlots = state.roomIds.length * QUOTA_PER_DOOR.admin;

  const revoke = async () => {
    const { txHash } = await dataSource.revokeCredential(revokeTarget.id);
    notify({
      tone: 'success',
      title: `Akses ${revokeTarget.name} dicabut`,
      message: `Kartu dihapus dari whitelist Kamar ${revokeTarget.roomId}. Tx ${truncateMiddle(txHash, 10, 6)}`,
    });
  };

  return (
    <>
      <PageHeader
        eyebrow="Access control & node ledger • Polygon L2"
        title="Manajemen Pengguna & Kredensial NFC"
        description="Kredensial MIFARE Classic 1K terenkripsi AES-128, terdaftar di smart contract dengan batas alokasi per pintu: 1 Penghuni dan 2 Admin."
        actions={
          <Button variant="primary" icon="add_card" onClick={() => setEnrolling(true)} disabled={!state.internetOnline} title={state.internetOnline ? undefined : 'Butuh koneksi internet'}>
            Tambah Kartu
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard label="Kredensial Aktif" value={summary.activeCredentials} unit="kartu" icon="contactless">
          <p className="font-mono text-label-mono-sm text-slate-400">
            {summary.residentCredentials} penghuni • <span className="text-tertiary-light">{summary.adminCredentials} admin</span>
          </p>
        </StatCard>
        <StatCard
          label="Slot Penghuni Terpakai"
          value={summary.residentCredentials}
          unit={`/ ${residentSlots}`}
          badge={<StatusChip tone="info">Maks {ROLES.resident.limit}/pintu</StatusChip>}
        >
          <ProgressBar value={(summary.residentCredentials / residentSlots) * 100} tone="info" label="Slot penghuni" />
        </StatCard>
        <StatCard
          label="Slot Admin Terpakai"
          value={summary.adminCredentials}
          unit={`/ ${adminSlots}`}
          badge={<StatusChip tone="warning">Maks {ROLES.admin.limit}/pintu</StatusChip>}
        >
          <ProgressBar value={(summary.adminCredentials / adminSlots) * 100} tone="warning" label="Slot admin" />
        </StatCard>
      </div>

      <section className="panel overflow-hidden" aria-label="Daftar pengguna">
        <div className="flex flex-col gap-3 border-b border-white/6 p-4 lg:flex-row lg:items-center">
          <SearchInput value={query} onChange={setQuery} label="Cari pengguna" placeholder="Cari nama, kamar, atau telepon..." className="lg:w-80" />
          <SegmentedControl label="Filter role" options={ROLE_FILTERS} value={roleFilter} onChange={setRoleFilter} className="overflow-x-auto" />
        </div>
        <ResidentTable rows={pageItems} quotaFor={quotaFor} onRevoke={setRevokeTarget} canRevoke={state.internetOnline} now={now} />
        <footer className="flex flex-col items-center justify-between gap-3 border-t border-white/6 p-4 sm:flex-row">
          <p className="font-mono text-label-mono-sm text-slate-400">
            Menampilkan {pageItems.length} dari {total} kredensial
          </p>
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        </footer>
      </section>

      <EnrollmentModal open={enrolling} onClose={() => setEnrolling(false)} />

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
        onConfirm={revoke}
        tone="destructive"
        title="Cabut Akses Pengguna?"
        description="Kartu akan dihapus dari whitelist node pintu dan status kredensial di smart contract menjadi revoked. Aksi ini tidak dapat dibatalkan; kartu harus didaftarkan ulang bila diperlukan."
        confirmLabel="Ya, Cabut Akses"
        details={
          revokeTarget && (
            <DetailList
              items={[
                ['Nama', revokeTarget.name],
                ['Kamar', revokeTarget.roomId],
                ['Tipe', ROLES[revokeTarget.role].label],
                ['UID hash', truncateMiddle(revokeTarget.uidHash, 8, 4)],
              ]}
            />
          )
        }
      />
    </>
  );
}
