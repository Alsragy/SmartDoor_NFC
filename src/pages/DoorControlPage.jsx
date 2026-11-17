import { useMemo, useState } from 'react';
import { AuditStream } from '../components/audit/AuditStream';
import { DoorGrid } from '../components/doors/DoorGrid';
import { PageHeader } from '../components/layout/PageHeader';
import { LocalQueuePanel } from '../components/simulation/LocalQueuePanel';
import { DetailList } from '../components/ui/DetailList';
import { Panel, PanelHeader } from '../components/ui/Panel';
import { SearchInput } from '../components/ui/SearchInput';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { AUTO_RELOCK_MS, FLOORS } from '../config/constants';
import { useDormChainState } from '../context/DormChainContext';
import { selectRoomViews } from '../services/selectors';

const FLOOR_OPTIONS = [{ value: 'all', label: 'Semua' }, ...FLOORS.map((f) => ({ value: String(f), label: `Lantai ${f}` }))];
const STATUS_OPTIONS = [
  { value: 'all', label: 'Semua Status' },
  { value: 'occupied', label: 'Terisi' },
  { value: 'empty', label: 'Kosong' },
  { value: 'attention', label: 'Offline / Baterai' },
];

const STATUS_FILTERS = {
  all: () => true,
  occupied: (r) => r.occupied,
  empty: (r) => !r.occupied,
  attention: (r) => !r.online || r.lowBattery,
};

export function DoorControlPage() {
  const state = useDormChainState();
  const rooms = useMemo(() => selectRoomViews(state), [state]);
  const [floor, setFloor] = useState('all');
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rooms.filter(
      (r) =>
        (floor === 'all' || String(r.floor) === floor) &&
        STATUS_FILTERS[status](r) &&
        (!q || r.roomId.includes(q) || r.resident?.name.toLowerCase().includes(q)),
    );
  }, [rooms, floor, status, query]);

  const online = rooms.filter((r) => r.online).length;

  return (
    <>
      <PageHeader
        eyebrow="ESP32 Solenoid Relay Mesh • MQTT TLS"
        eyebrowTone={state.internetOnline ? 'success' : 'warning'}
        title="Status Pintu & Kontrol Solenoid Kamar"
        description="Kontrol langsung solenoid lock ESP32 via MQTT TLS. Otentikasi ganda melalui kartu NFC MIFARE dan konsensus ledger."
      />

      <div className="panel flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
        <SegmentedControl label="Filter lantai" options={FLOOR_OPTIONS} value={floor} onChange={setFloor} className="overflow-x-auto" />
        <SegmentedControl label="Filter status" options={STATUS_OPTIONS} value={status} onChange={setStatus} className="overflow-x-auto" />
        <SearchInput value={query} onChange={setQuery} label="Cari kamar atau penghuni" placeholder="Cari kamar atau penghuni..." className="lg:ml-auto lg:w-72" />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <section aria-label="Daftar pintu kamar" className="xl:col-span-8">
          <DoorGrid rooms={filtered} />
        </section>

        <aside className="flex flex-col gap-6 xl:col-span-4">
          <Panel>
            <PanelHeader icon="tune" title="Diagnostik Solenoid & Mesh" subtitle="Parameter node saat ini" />
            <div className="inset-well p-4">
              <DetailList
                items={[
                  ['Node online', `${online} / ${rooms.length}`],
                  ['Durasi pulsa solenoid', `${AUTO_RELOCK_MS / 1000} detik`],
                  ['Relay', '12V • 1.8A'],
                  ['Mode gagal', 'Fail-secure'],
                  ['Broker', state.internetOnline ? 'Terhubung' : 'Terputus'],
                ]}
              />
            </div>
          </Panel>
          <LocalQueuePanel />
          <AuditStream entries={state.auditLog} limit={5} />
        </aside>
      </div>
    </>
  );
}
