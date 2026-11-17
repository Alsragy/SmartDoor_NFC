# DormChain Admin Dashboard (frontend)

Vite + React 19 + Tailwind CSS v4. Data saat ini berasal dari simulasi lokal (`SimulationService`).

```powershell
npm install
npm run dev      # http://localhost:5173
npm run build
```

## Struktur

```
src/
  config/        konstanta (kuota per pintu, ambang baterai, timeout) & navigasi
  services/
    contract.js          kontrak DataSource (JSDoc) + ServiceError
    SimulationService.js mock gateway ESP32 + ledger Polygon (store-and-forward)
    mockData.js          data seed 24 kamar
    selectors.js         turunan state untuk UI
    dataSource.js        titik pemilihan adapter (VITE_DATA_SOURCE)
  context/       DormChainProvider (useSyncExternalStore) & ToastProvider
  hooks/         router hash, countdown, pagination, kontrol simulasi
  components/
    ui/          Button, StatusChip, Modal, ConfirmDialog, StatCard, ...
    layout/      Sidebar, Topbar, PageHeader, AppShell
    doors/       DoorCard, DoorGrid, BatteryIndicator
    users/       ResidentTable, EnrollmentModal, CountdownRing
    audit/       AuditTable, AuditStream, SyncBadge
    overview/    SummaryStats, AlertPanel
    simulation/  InternetToggle, DevPanel, OfflineBanner, LocalQueuePanel
  pages/         Overview, DoorControl, Users, AuditLog
  utils/         sanitize, format, ids, cx
```

## Mengganti simulasi dengan perangkat sungguhan

1. Buat adapter baru (mis. `src/services/MqttDataSource.js`) yang mengimplementasikan
   method di `contract.js`: `subscribe`, `getState`, `start`, `stop`, `unlockDoor`,
   `pingNode`, `getQuota`, `waitForCardTap`, `registerCredential`, `revokeCredential`.
2. Set `capabilities = { simulation: false }` agar toggle internet & panel developer disembunyikan.
3. Tambahkan case di `src/services/dataSource.js` dan set `VITE_DATA_SOURCE` di `.env`.

Komponen UI tidak perlu diubah.
