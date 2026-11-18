# DormChain Admin Dashboard (frontend)

Vite + React 19 + Tailwind CSS v4. Data saat ini berasal dari simulasi lokal (`SimulationService`).

```powershell
npm install
npm run dev      # http://localhost:5173
npm run build
```

## Struktur

```text
/ (Root)
  vite.config.js          # Konfigurasi Vite + Custom Middleware (/api/terminal-log) untuk log blockchain di terminal
src/
  config/                 # Konstanta (kuota per pintu, ambang baterai, timeout) & navigasi
  services/
    contract.js           # Kontrak antarmuka DataSource (JSDoc) + ServiceError
    SimulationService.js  # Mock gateway ESP32 + local blockchain ledger + pengirim log terminal
    mockData.js           # Data seed 24 kamar
    selectors.js          # Turunan state untuk UI
    dataSource.js         # Titik pemilihan adapter (berdasarkan VITE_DATA_SOURCE)
  context/                # DormChainProvider (useSyncExternalStore) & ToastProvider
  hooks/                  # Router hash, countdown, pagination, kontrol simulasi
  components/
    ui/                   # Button, StatusChip, Modal, ConfirmDialog, StatCard, ...
    layout/               # Sidebar, Topbar, PageHeader, AppShell
    doors/                # DoorCard, DoorGrid, BatteryIndicator
    users/                # ResidentTable, EnrollmentModal, CountdownRing
    audit/                # AuditTable, AuditStream, SyncBadge
    overview/             # SummaryStats, AlertPanel
    simulation/           # InternetToggle, DevPanel, OfflineBanner, LocalQueuePanel
  pages/                  # Overview, DoorControl, Users, AuditLog
  utils/                  # Sanitize, format, ids, cx
```

## Mengganti simulasi dengan perangkat sungguhan

Tahap simulasi saat ini menggunakan `SimulationService.js` untuk *mocking* data dan middleware di `vite.config.js` untuk mencetak proses blockchain ke terminal lokal. Untuk menyambungkan *frontend* ini ke perangkat keras IoT (ESP32) dan Backend sungguhan, ikuti langkah berikut:

1. **Buat Adapter Baru:** Buat *file* (mis. `src/services/MqttDataSource.js` atau `ApiDataSource.js`) yang mematuhi dan mengimplementasikan seluruh fungsi pada `contract.js` (`subscribe`, `getState`, `start`, `stop`, `unlockDoor`, `registerCredential`, dll) menggunakan pemanggilan API/MQTT ke *backend* asli Anda.
2. **Matikan Fitur Simulasi:** Pada adapter baru Anda, set `capabilities = { simulation: false }`. Ini akan otomatis menyembunyikan elemen UI khusus *developer* seperti `InternetToggle`, `DevPanel`, dan memaksa data ditarik dari *server* sungguhan.
3. **Pindahkan Log Terminal:** Pencetakan log (seperti status hashing SHA-256 dan blok baru) tidak lagi ditangani oleh *frontend* lewat `fetch('/api/terminal-log')`. Log keamanan ini akan sepenuhnya dieksekusi dan dicetak oleh server *backend* Node.js/Python Anda.
4. **Ubah Environment Variable:** Tambahkan adapter baru Anda ke *switch case* di `src/services/dataSource.js` dan ubah variabel `VITE_DATA_SOURCE` di dalam file `.env` untuk menunjuk ke adapter asli tersebut.
