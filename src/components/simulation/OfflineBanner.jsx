import { useDormChainState } from '../../context/DormChainContext';
import { Icon } from '../ui/Icon';

/** Banner peringatan saat gateway kehilangan koneksi internet. */
export function OfflineBanner() {
  const { internetOnline, localQueue } = useDormChainState();
  if (internetOnline) return null;

  return (
    <div role="status" className="flex items-start gap-3 rounded-2xl border border-tertiary/40 bg-tertiary/8 p-4 shadow-glow-tertiary">
      <Icon name="cloud_off" size={24} className="mt-0.5 text-tertiary-light" />
      <div className="text-sm">
        <p className="font-semibold text-tertiary-light">Mode Luring: koneksi internet gateway terputus</p>
        <p className="mt-0.5 text-slate-300">
          Kunci pintu tetap berjalan dengan whitelist lokal. Setiap tap disimpan di antrean lokal ESP32 (
          <span className="font-mono text-tertiary-light">{localQueue.length} event</span>) dan dikirim sebagai
          &quot;Susulan Luring&quot; ketika internet kembali ON. Perintah remote dinonaktifkan sementara.
        </p>
      </div>
    </div>
  );
}
