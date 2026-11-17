import { SimulationService } from './SimulationService';

/**
 * Titik tunggal pemilihan sumber data (plug-and-play).
 *
 * Untuk menghubungkan ke perangkat sungguhan, buat adapter baru yang
 * mengimplementasikan `DataSource` (lihat contract.js), misalnya
 * `MqttDataSource`, lalu tambahkan case di bawah dan set
 * `VITE_DATA_SOURCE=mqtt` di file .env.
 *
 * @returns {import('./contract').DataSource}
 */
export function createDataSource() {
  const mode = import.meta.env.VITE_DATA_SOURCE ?? 'simulation';

  switch (mode) {
    case 'simulation':
      return new SimulationService();
    default:
      console.warn(`[DormChain] VITE_DATA_SOURCE="${mode}" belum tersedia, memakai simulasi.`);
      return new SimulationService();
  }
}
