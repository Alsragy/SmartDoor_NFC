import { useMemo, useState } from 'react';
import { AuditTable } from '../components/audit/AuditTable';
import { PageHeader } from '../components/layout/PageHeader';
import { Icon } from '../components/ui/Icon';
import { Pagination } from '../components/ui/Pagination';
import { SearchInput } from '../components/ui/SearchInput';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { StatCard } from '../components/ui/StatCard';
import { StatusChip } from '../components/ui/StatusChip';
import { useDormChainState } from '../context/DormChainContext';
import { useNow } from '../hooks/useNow';
import { usePagination } from '../hooks/usePagination';
import { formatNumber, isSameDay, truncateMiddle } from '../utils/format';
import { sanitizeEnum } from '../utils/sanitize';

const PAGE_SIZE = 10;
const DIRECTION_OPTIONS = [
  { value: 'all', label: 'Semua Arah' },
  { value: 'in', label: 'Masuk' },
  { value: 'out', label: 'Keluar' },
];
const SYNC_OPTIONS = [
  { value: 'all', label: 'Semua Status' },
  {
    value: 'realtime',
    label: (
      <>
        <span className="size-1.5 rounded-full bg-primary-light" /> Real-time
      </>
    ),
  },
  {
    value: 'offline',
    label: (
      <>
        <span className="size-1.5 rounded-full bg-tertiary-light" /> Susulan Luring
      </>
    ),
  },
];

export function AuditLogPage() {
  const state = useDormChainState();
  const now = useNow();
  const [direction, setDirection] = useState('all');
  const [sync, setSync] = useState('all');
  const [roomId, setRoomId] = useState('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return state.auditLog.filter(
      (e) =>
        (direction === 'all' || e.direction === direction) &&
        (sync === 'all' || e.syncMode === sync) &&
        (roomId === 'all' || e.roomId === roomId) &&
        (!q || e.name.toLowerCase().includes(q) || e.txHash.toLowerCase().includes(q) || e.roomId.includes(q)),
    );
  }, [state.auditLog, direction, sync, roomId, query]);

  const { page, pageCount, pageItems, setPage, total } = usePagination(filtered, PAGE_SIZE, `${direction}|${sync}|${roomId}|${query}`);

  const today = state.auditLog.filter((e) => isSameDay(e.eventAt, now));
  const offlineToday = today.filter((e) => e.syncMode === 'offline').length;
  const latest = state.auditLog[0];

  return (
    <>
      <PageHeader
        eyebrow="Ledger synchronization engine • L2 Mainnet RPC"
        eyebrowTone={state.internetOnline ? 'success' : 'warning'}
        title="Pusat Sinkronisasi & Riwayat Akses Blockchain"
        description="Catatan immutable SHA-256 yang divalidasi ke Polygon Layer-2. Log dari node yang luring disimpan lokal lalu dikirim susulan saat koneksi pulih."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Blok Terkini Polygon" value={`#${formatNumber(state.ledger.blockNumber)}`} icon="layers">
          <StatusChip tone={state.internetOnline ? 'success' : 'warning'} dot>
            {state.internetOnline ? 'Terkonfirmasi final' : 'RPC terputus'}
          </StatusChip>
        </StatCard>
        <StatCard label="Registry Kontrak" value={truncateMiddle(state.ledger.contractAddress, 6, 4)} tone="info" icon="receipt_long">
          <p className="font-mono text-label-mono-sm text-slate-400">Solidity 0.8.24 • Mainnet V2</p>
        </StatCard>
        <StatCard label="Akses Hari Ini" value={today.length} unit="transaksi" icon="schedule">
          <p className="font-mono text-label-mono-sm text-slate-400">
            <span className="text-primary-light">{today.length - offlineToday} real-time</span> •{' '}
            <span className="text-tertiary-light">{offlineToday} luring</span>
          </p>
        </StatCard>
        <StatCard
          label="Antrean Lokal ESP32"
          value={state.localQueue.length}
          unit="event"
          tone={state.localQueue.length ? 'warning' : 'success'}
          icon="inventory_2"
        >
          <p className="font-mono text-label-mono-sm text-slate-400">
            {state.localQueue.length ? 'Menunggu internet / node pulih' : 'Semua event tersinkron'}
          </p>
        </StatCard>
      </div>

      <div className="flex items-start gap-4 rounded-2xl border border-tertiary/30 bg-surface-container p-5">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-tertiary/40 bg-tertiary/10 text-tertiary-light">
          <Icon name="memory" size={24} />
        </span>
        <div className="text-sm">
          <p className="flex flex-wrap items-center gap-2 font-display text-headline-sm text-white">
            Protokol Fail-Safe Flash ESP32
            <StatusChip tone="warning">{offlineToday} log susulan hari ini</StatusChip>
          </p>
          <p className="mt-1 text-slate-400">
            Smart lock tetap mencatat akses ke SPIFFS internal saat Wi-Fi terputus. Baris dengan badge{' '}
            <span className="text-tertiary-light">Susulan Luring</span> menunjukkan waktu kejadian asli dan waktu sinkronisasi ke Polygon L2.
          </p>
        </div>
      </div>

      <section className="panel overflow-hidden" aria-label="Riwayat akses">
        <div className="flex flex-col gap-3 border-b border-white/6 p-4 xl:flex-row xl:flex-wrap xl:items-center">
          <SearchInput value={query} onChange={setQuery} label="Cari log" placeholder="Cari nama, kamar, atau hash..." className="xl:w-72" />
          <SegmentedControl label="Filter arah" options={DIRECTION_OPTIONS} value={direction} onChange={setDirection} />
          <SegmentedControl label="Filter status sinkronisasi" options={SYNC_OPTIONS} value={sync} onChange={setSync} className="overflow-x-auto" />
          <label className="flex items-center gap-2">
            <span className="sr-only">Filter kamar</span>
            <select
              value={roomId}
              onChange={(e) => setRoomId(sanitizeEnum(e.target.value, ['all', ...state.roomIds], 'all'))}
              className="field h-10 w-48 px-3 text-sm"
            >
              <option value="all">Semua Kamar</option>
              {state.roomIds.map((id) => (
                <option key={id} value={id}>
                  Kamar {id}
                </option>
              ))}
            </select>
          </label>
        </div>

        <AuditTable entries={pageItems} now={now} />

        <footer className="flex flex-col items-center justify-between gap-3 border-t border-white/6 p-4 sm:flex-row">
          <p className="flex items-center gap-2 font-mono text-label-mono-sm text-slate-400">
            <Icon name="verified_user" size={16} className="text-primary-light" />
            {total} entri • Blok terakhir #{latest ? formatNumber(latest.blockNumber) : '-'}
          </p>
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        </footer>
      </section>
    </>
  );
}
