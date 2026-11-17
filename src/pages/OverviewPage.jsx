import { useMemo } from 'react';
import { AuditStream } from '../components/audit/AuditStream';
import { DoorGrid } from '../components/doors/DoorGrid';
import { PageHeader } from '../components/layout/PageHeader';
import { AlertPanel } from '../components/overview/AlertPanel';
import { SummaryStats } from '../components/overview/SummaryStats';
import { LocalQueuePanel } from '../components/simulation/LocalQueuePanel';
import { StatusChip } from '../components/ui/StatusChip';
import { useDormChainState } from '../context/DormChainContext';
import { selectRoomViews, selectSummary } from '../services/selectors';

export function OverviewPage() {
  const state = useDormChainState();
  const rooms = useMemo(() => selectRoomViews(state), [state]);
  const summary = useMemo(() => selectSummary(state, rooms), [state, rooms]);

  return (
    <>
      <PageHeader
        eyebrow="Sistem telemetri real-time • Kos Griya Harmoni"
        eyebrowTone={state.internetOnline ? 'success' : 'warning'}
        title="Pusat Ringkasan & Monitoring IoT"
        description="Konsol pemantauan node kunci pintu ESP32 Mesh yang tersertifikasi smart contract ledger Polygon L2."
        actions={
          <>
            <StatusChip tone="info">ESP32 Mesh v2.4.12</StatusChip>
            <StatusChip tone={state.internetOnline ? 'success' : 'critical'} dot>
              MQTT {state.internetOnline ? 'terhubung' : 'terputus'}
            </StatusChip>
          </>
        }
      />

      <SummaryStats summary={summary} internetOnline={state.internetOnline} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <section aria-labelledby="room-grid-title" className="flex flex-col gap-4 xl:col-span-8">
          <div className="flex items-center justify-between">
            <h2 id="room-grid-title" className="font-display text-headline-md text-white">
              Grid Kamar
            </h2>
            <a href="#/doors" className="text-xs font-semibold text-secondary-light hover:underline">
              Filter & kontrol lengkap
            </a>
          </div>
          <DoorGrid rooms={rooms} />
        </section>

        <aside className="flex flex-col gap-6 xl:col-span-4">
          <AlertPanel rooms={rooms} internetOnline={state.internetOnline} />
          <LocalQueuePanel />
          <AuditStream entries={state.auditLog} />
        </aside>
      </div>
    </>
  );
}
