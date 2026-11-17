import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { createDataSource } from '../services/dataSource';

const DataSourceContext = createContext(null);

/**
 * Menyediakan satu instance DataSource untuk seluruh aplikasi dan
 * menjalankan/menghentikan loop simulasinya mengikuti lifecycle React.
 */
export function DormChainProvider({ children, dataSource: injected }) {
  const [dataSource] = useState(() => injected ?? createDataSource());

  useEffect(() => {
    dataSource.start();
    return () => dataSource.stop();
  }, [dataSource]);

  return <DataSourceContext.Provider value={dataSource}>{children}</DataSourceContext.Provider>;
}

/** Akses method DataSource (unlockDoor, registerCredential, ...). */
export function useDataSource() {
  const dataSource = useContext(DataSourceContext);
  if (!dataSource) throw new Error('useDataSource harus dipakai di dalam <DormChainProvider>.');
  return dataSource;
}

/** Snapshot state terbaru; komponen re-render setiap state berubah. */
export function useDormChainState() {
  const dataSource = useDataSource();
  return useSyncExternalStore(dataSource.subscribe, dataSource.getState, dataSource.getState);
}
