import { AppShell } from './components/layout/AppShell';
import { DEFAULT_ROUTE, ROUTES } from './config/navigation';
import { useHashRoute } from './hooks/useHashRoute';
import { AuditLogPage } from './pages/AuditLogPage';
import { DoorControlPage } from './pages/DoorControlPage';
import { OverviewPage } from './pages/OverviewPage';
import { UsersPage } from './pages/UsersPage';

const PAGES = {
  overview: OverviewPage,
  doors: DoorControlPage,
  users: UsersPage,
  audit: AuditLogPage,
};

export default function App() {
  const route = useHashRoute(ROUTES, DEFAULT_ROUTE);
  const Page = PAGES[route];

  return (
    <AppShell route={route}>
      <Page />
    </AppShell>
  );
}
