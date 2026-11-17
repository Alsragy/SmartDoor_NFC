import { LOW_BATTERY_THRESHOLD } from '../../config/constants';
import { ProgressBar } from '../ui/ProgressBar';
import { StatCard } from '../ui/StatCard';
import { StatusChip } from '../ui/StatusChip';

/** Header cards Ringkasan: okupansi, jaringan, baterai UPS, dan ledger. */
export function SummaryStats({ summary, internetOnline }) {
  const occupancy = Math.round((summary.occupied / summary.totalRooms) * 100);
  const lowBattery = summary.lowBatteryRooms;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="Okupansi Kamar"
        value={summary.occupied}
        unit={`/ ${summary.totalRooms} kamar`}
        badge={<StatusChip tone="success">{occupancy}% terisi</StatusChip>}
      >
        <ProgressBar value={occupancy} label="Okupansi kamar" />
        <p className="mt-2 font-mono text-label-mono-sm text-slate-400">{summary.totalRooms - summary.occupied} kamar kosong</p>
      </StatCard>

      <StatCard
        label="Status Jaringan (Simulasi)"
        value={summary.online}
        unit="node online"
        tone={summary.offline ? 'warning' : 'success'}
        glow={internetOnline ? undefined : 'shadow-glow-critical'}
        badge={
          internetOnline ? (
            <StatusChip tone="success" dot pulse>
              Internet ON
            </StatusChip>
          ) : (
            <StatusChip tone="critical" dot>
              Internet OFF
            </StatusChip>
          )
        }
      >
        <p className="font-mono text-label-mono-sm text-slate-400">
          <span className={summary.offline ? 'text-critical-light' : 'text-slate-400'}>{summary.offline} offline</span>
          {' • '}
          <span className={summary.queueLength ? 'text-tertiary-light' : 'text-slate-400'}>{summary.queueLength} antrean lokal</span>
        </p>
      </StatCard>

      <StatCard
        label={`Peringatan Baterai UPS (<${LOW_BATTERY_THRESHOLD}%)`}
        value={lowBattery.length}
        unit="node perlu servis"
        tone={lowBattery.length ? 'warning' : 'success'}
        badge={lowBattery.length ? <StatusChip tone="warning">Perlu tindakan</StatusChip> : <StatusChip tone="success">Aman</StatusChip>}
      >
        <ul className="flex flex-col gap-1.5">
          {lowBattery.slice(0, 3).map((room) => (
            <li
              key={room.roomId}
              className="flex justify-between rounded-md border border-critical/25 bg-critical/8 px-2 py-1 font-mono text-label-mono-sm text-critical-light"
            >
              <span>Kmr {room.roomId}</span>
              <span>
                {room.node.battery}% • {room.node.voltage} V
              </span>
            </li>
          ))}
          {lowBattery.length === 0 && <li className="font-mono text-label-mono-sm text-slate-400">Semua baterai di atas ambang.</li>}
        </ul>
      </StatCard>

      <StatCard
        label="Ledger Audit Hari Ini"
        value={summary.todayLogs}
        unit="tap log"
        badge={<StatusChip tone="info">On-chain</StatusChip>}
      >
        <p className="font-mono text-label-mono-sm text-slate-400">
          Real-time: <span className="text-primary-light">{summary.todayRealtime}</span> • Susulan:{' '}
          <span className="text-tertiary-light">{summary.todayOffline}</span>
        </p>
      </StatCard>
    </div>
  );
}
