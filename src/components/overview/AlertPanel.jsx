import { useState } from 'react';
import { useDataSource } from '../../context/DormChainContext';
import { useToast } from '../../context/ToastContext';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Panel, PanelHeader } from '../ui/Panel';
import { StatusChip } from '../ui/StatusChip';

/** Daftar node yang butuh perhatian: offline hardware & baterai kritis. */
export function AlertPanel({ rooms, internetOnline }) {
  const dataSource = useDataSource();
  const { notify } = useToast();
  const [pinging, setPinging] = useState(null);

  const alerts = [
    ...rooms
      .filter((r) => !r.node.hardwareOnline)
      .map((r) => ({
        id: `off-${r.roomId}`,
        room: r,
        tone: 'critical',
        icon: 'cloud_off',
        title: `Node Kamar ${r.roomId} hilang kontak`,
        body: 'Fail-secure aktif: pintu tetap terkunci, kartu terdaftar tetap bisa membuka via whitelist lokal.',
        canPing: true,
      })),
    ...rooms
      .filter((r) => r.lowBattery)
      .map((r) => ({
        id: `bat-${r.roomId}`,
        room: r,
        tone: 'warning',
        icon: 'battery_alert',
        title: `Baterai kritis Kamar ${r.roomId}`,
        body: `UPS ${r.node.battery}% (${r.node.voltage} V). Ganti baterai 18650 Li-ion segera.`,
      })),
  ];

  const ping = async (roomId) => {
    setPinging(roomId);
    try {
      const { flushed } = await dataSource.pingNode(roomId);
      notify({
        tone: 'success',
        title: `Node Kamar ${roomId} kembali online`,
        message: flushed ? `${flushed} log susulan dari node ini dikirim ke ledger.` : 'Keep-alive MQTT pulih.',
      });
    } catch (error) {
      notify({ tone: 'critical', title: 'Ping gagal', message: error.message });
    } finally {
      setPinging(null);
    }
  };

  return (
    <Panel>
      <PanelHeader
        icon="warning"
        iconClassName="text-tertiary-light"
        title="Peringatan Sistem"
        subtitle="Node yang perlu perhatian"
        action={<StatusChip tone={alerts.length ? 'critical' : 'success'}>{alerts.length} item</StatusChip>}
      />
      {alerts.length === 0 ? (
        <p className="inset-well p-3 text-xs text-slate-400">Semua node sehat.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {alerts.map((alert) => (
            <li key={alert.id} className="inset-well flex gap-3 p-3">
              <Icon
                name={alert.icon}
                size={20}
                className={alert.tone === 'critical' ? 'text-critical-light' : 'text-tertiary-light'}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-100">{alert.title}</p>
                <p className="mt-0.5 text-xs text-slate-400">{alert.body}</p>
                {alert.canPing && (
                  <Button
                    size="sm"
                    variant="primary"
                    icon="wifi_tethering"
                    className="mt-2"
                    loading={pinging === alert.room.roomId}
                    disabled={!internetOnline}
                    onClick={() => ping(alert.room.roomId)}
                  >
                    Ping Node
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
