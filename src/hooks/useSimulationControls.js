import { useCallback } from 'react';
import { useDataSource } from '../context/DormChainContext';
import { useToast } from '../context/ToastContext';

/** Aksi khusus simulasi yang dipakai bersama oleh Topbar dan DevPanel. */
export function useSimulationControls() {
  const dataSource = useDataSource();
  const { notify } = useToast();
  const available = dataSource.capabilities?.simulation === true;

  const setInternet = useCallback(
    (online) => {
      if (!available) return;
      const { flushed } = dataSource.setInternet(online);
      if (!online) {
        notify({
          tone: 'warning',
          title: 'Simulasi internet OFF',
          message: 'Node beralih ke mode luring. Tap kartu disimpan di antrean lokal ESP32.',
        });
      } else if (flushed > 0) {
        notify({
          tone: 'success',
          title: `${flushed} log susulan tersinkron`,
          message: 'Antrean lokal telah dicatat ke ledger dengan badge "Susulan Luring".',
        });
      } else {
        notify({ tone: 'success', title: 'Simulasi internet ON', message: 'Tidak ada antrean lokal yang perlu dikirim.' });
      }
    },
    [available, dataSource, notify],
  );

  const simulateTap = useCallback(
    (roomId) => {
      try {
        const { queued } = dataSource.simulateTap(roomId);
        notify({
          tone: queued ? 'warning' : 'info',
          title: `Tap NFC Kamar ${roomId}`,
          message: queued ? 'Node luring: event masuk antrean lokal.' : 'Event tercatat real-time di ledger.',
        });
      } catch (error) {
        notify({ tone: 'critical', title: 'Tap gagal', message: error.message });
      }
    },
    [dataSource, notify],
  );

  return {
    available,
    setInternet,
    simulateTap,
    setAutoTraffic: (enabled) => dataSource.setAutoTraffic?.(enabled),
    reset: () => dataSource.reset?.(),
  };
}
