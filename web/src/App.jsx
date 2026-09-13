import React from 'react';
import { RouterProvider, useRouter, matchPath } from './router.jsx';
import { AuthProvider, ToastProvider, useAuth, hasRole } from './store.jsx';
import { Layout } from './components/Layout.jsx';
import { Loading } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Inbox from './pages/Inbox.jsx';
import Contacts from './pages/Contacts.jsx';
import Campaigns from './pages/Campaigns.jsx';
import Templates from './pages/Templates.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Team from './pages/Team.jsx';
import Bots from './pages/Bots.jsx';
import Numbers from './pages/Numbers.jsx';
import Settings from './pages/Settings.jsx';

const ROUTES = [
  { pattern: '/inbox', page: Inbox, title: 'Bandeja', role: 'viewer' },
  { pattern: '/inbox/:conversationId', page: Inbox, title: 'Bandeja', role: 'viewer' },
  { pattern: '/contacts', page: Contacts, title: 'Contactos', role: 'viewer' },
  { pattern: '/contacts/:contactId', page: Contacts, title: 'Contactos', role: 'viewer' },
  { pattern: '/campaigns', page: Campaigns, title: 'Campañas', role: 'admin' },
  { pattern: '/campaigns/:campaignId', page: Campaigns, title: 'Campañas', role: 'admin' },
  { pattern: '/templates', page: Templates, title: 'Plantillas', role: 'viewer' },
  { pattern: '/dashboard', page: Dashboard, title: 'Dashboard', role: 'viewer' },
  { pattern: '/numbers', page: Numbers, title: 'Números de WhatsApp', role: 'admin' },
  { pattern: '/bots', page: Bots, title: 'Chatbots conectados', role: 'admin' },
  { pattern: '/team', page: Team, title: 'Equipo', role: 'admin' },
  { pattern: '/settings', page: Settings, title: 'Ajustes', role: 'agent' },
];

function Routes() {
  const { path, navigate } = useRouter();
  const { user, ready } = useAuth();

  if (!ready) return <Loading label="Iniciando…" />;
  if (!user) return <Login />;

  if (path === '/' || path === '/login') {
    navigate('/inbox', { replace: true });
    return null;
  }

  for (const route of ROUTES) {
    const params = matchPath(route.pattern, path);
    if (!params) continue;
    if (!hasRole(user, route.role)) {
      navigate('/inbox', { replace: true });
      return null;
    }
    const Page = route.page;
    return (
      <Layout title={route.title}>
        <Page params={params} />
      </Layout>
    );
  }

  return (
    <Layout title="No encontrado">
      <div className="empty"><h3>Esta página no existe</h3></div>
    </Layout>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <RouterProvider>
          <Routes />
        </RouterProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
