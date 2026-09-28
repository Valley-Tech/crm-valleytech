import React, { useEffect } from 'react';
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
import Users from './pages/Users.jsx';
import Bots from './pages/Bots.jsx';
import BotAI from './pages/BotAI.jsx';
import Numbers from './pages/Numbers.jsx';
import Settings from './pages/Settings.jsx';

/**
 * Quién entra a cada página:
 *  · viewer/agent/owner/admin ven solo lo de sus números asignados (el
 *    backend filtra; aquí solo se decide qué menú aparece).
 *  · Campañas: desde Dueño. Usuarios: Administrador y SuperAdmin.
 *  · Configuración: Números y Ajustes solo SuperAdmin; Chatbots también para el Dueño (solo el suyo, solo IA).
 */
const ROUTES = [
  { pattern: '/inbox', page: Inbox, title: 'Bandeja', role: 'viewer' },
  { pattern: '/inbox/:conversationId', page: Inbox, title: 'Bandeja', role: 'viewer' },
  { pattern: '/contacts', page: Contacts, title: 'Contactos', role: 'viewer' },
  { pattern: '/contacts/:contactId', page: Contacts, title: 'Contactos', role: 'viewer' },
  { pattern: '/campaigns', page: Campaigns, title: 'Campañas', role: 'owner' },
  { pattern: '/campaigns/:campaignId', page: Campaigns, title: 'Campañas', role: 'owner' },
  { pattern: '/templates', page: Templates, title: 'Plantillas', role: 'viewer' },
  { pattern: '/dashboard', page: Dashboard, title: 'Dashboard', role: 'viewer' },
  { pattern: '/users', page: Users, title: 'Usuarios', role: 'admin' },
  { pattern: '/team', page: Users, title: 'Usuarios', role: 'admin' },
  { pattern: '/numbers', page: Numbers, title: 'Números de WhatsApp', role: 'superadmin' },
  // Chatbots: el SuperAdmin administra todos; un Dueño ve solo el suyo (info + IA y conocimiento).
  { pattern: '/bots', page: Bots, title: 'Chatbots conectados', role: 'owner' },
  { pattern: '/bots/:botId/ai', page: BotAI, title: 'IA y conocimiento', role: 'owner' },
  { pattern: '/settings', page: Settings, title: 'Ajustes', role: 'superadmin' },
];

function Routes() {
  const { path, navigate } = useRouter();
  const { user, ready } = useAuth();

  // Redirecciones: a la bandeja desde "/" y desde páginas que el rol no puede ver.
  const match = ROUTES.map((route) => ({ route, params: matchPath(route.pattern, path) })).find((m) => m.params);
  const redirect = Boolean(user) && (path === '/' || path === '/login' || (match && !hasRole(user, match.route.role)));
  useEffect(() => {
    if (redirect) navigate('/inbox', { replace: true });
  }, [redirect, navigate]);

  if (!ready) return <Loading label="Iniciando…" />;
  if (!user) return <Login />;
  if (redirect) return null;

  for (const route of ROUTES) {
    const params = matchPath(route.pattern, path);
    if (!params) continue;
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
