import { DevPanel } from '../simulation/DevPanel';
import { OfflineBanner } from '../simulation/OfflineBanner';
import { MobileNav, Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

export function AppShell({ route, children }) {
  return (
    <div className="min-h-screen bg-canvas">
      <Sidebar route={route} />
      <div className="md:pl-20 xl:pl-65">
        <Topbar />
        <main className="mx-auto flex max-w-[1680px] flex-col gap-6 px-4 pt-6 pb-28 md:px-8 md:pb-12">
          <OfflineBanner />
          {children}
        </main>
      </div>
      <MobileNav route={route} />
      <DevPanel />
    </div>
  );
}
