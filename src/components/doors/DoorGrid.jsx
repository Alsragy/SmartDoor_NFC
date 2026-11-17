import { useCallback, useState } from 'react';
import { useDataSource, useDormChainState } from '../../context/DormChainContext';
import { useToast } from '../../context/ToastContext';
import { truncateMiddle } from '../../utils/format';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DetailList } from '../ui/DetailList';
import { Icon } from '../ui/Icon';
import { DoorCard } from './DoorCard';

/**
 * Grid kartu pintu + alur konfirmasi "Buka Pintu Jarak Jauh".
 * Dipakai di halaman Ringkasan dan Kontrol Pintu.
 */
export function DoorGrid({ rooms }) {
  const dataSource = useDataSource();
  const { internetOnline } = useDormChainState();
  const { notify } = useToast();
  const [target, setTarget] = useState(null);

  const requestUnlock = useCallback((room) => setTarget(room), []);

  const unlock = async () => {
    const { txHash } = await dataSource.unlockDoor(target.roomId);
    notify({
      tone: 'success',
      title: `Pintu Kamar ${target.roomId} dibuka`,
      message: `Perintah remote tercatat di ledger: ${truncateMiddle(txHash, 10, 6)}`,
    });
  };

  if (rooms.length === 0) {
    return (
      <div className="panel flex flex-col items-center gap-2 p-10 text-center text-sm text-slate-400">
        <Icon name="search_off" size={28} />
        Tidak ada kamar yang cocok dengan filter.
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
        {rooms.map((room) => (
          <DoorCard key={room.roomId} room={room} internetOnline={internetOnline} onRequestUnlock={requestUnlock} />
        ))}
      </div>

      <ConfirmDialog
        open={Boolean(target)}
        onClose={() => setTarget(null)}
        onConfirm={unlock}
        title={`Buka Pintu Kamar ${target?.roomId ?? ''}?`}
        description="Perintah akan dikirim via MQTT TLS ke node ESP32 dan solenoid terbuka selama 5 detik sebelum terkunci otomatis. Aksi ini tercatat permanen di ledger audit."
        confirmLabel="Ya, Buka Pintu"
        details={
          target && (
            <DetailList
              items={[
                ['Kamar', `${target.roomId} (Lantai ${target.floor})`],
                ['Penghuni', target.resident?.name ?? 'Kosong'],
                ['Sinyal node', `${target.node.rssi} dBm`],
                ['Baterai UPS', `${target.node.battery}%`],
              ]}
            />
          )
        }
      />
    </>
  );
}
