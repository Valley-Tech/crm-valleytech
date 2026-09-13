import React from 'react';
import { Link, useRouter } from '../router.jsx';
import { useAuth, hasRole } from '../store.jsx';
import { Avatar } from './ui.jsx';
import { I } from './Icons.jsx';

const NAV = [
  { section: 'Operación' },
  { to: '/inbox', label: 'Bandeja', icon: I.inbox, role: 'viewer' },
  { to: '/contacts', label: 'Contactos', icon: I.contacts, role: 'viewer' },
  { to: '/campaigns', label: 'Campañas', icon: I.campaigns, role: 'admin' },
  { to: '/templates', label: 'Plantillas', icon: I.templates, role: 'viewer' },
  { section: 'Análisis' },
  { to: '/dashboard', label: 'Dashboard', icon: I.dashboard, role: 'viewer' },
  { section: 'Configuración' },
  { to: '/numbers', label: 'Números de WhatsApp', icon: I.numbers, role: 'admin' },
  { to: '/bots', label: 'Chatbots', icon: I.bots, role: 'admin' },
  { to: '/team', label: 'Equipo', icon: I.team, role: 'admin' },
  { to: '/settings', label: 'Ajustes', icon: I.settings, role: 'agent' },
];

export function Layout({ children, title }) {
  const { user, logout } = useAuth();
  const { path } = useRouter();
  const visible = NAV.filter((item) => item.section || hasRole(user, item.role));
  const isInbox = path.startsWith('/inbox');

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="mark">V</span>
          <div>
            <strong>{user?.tenant?.name ?? 'CRM'}</strong>
            <small>CRM ValleyTech</small>
          </div>
        </div>
        <nav className="nav">
          {visible.map((item, i) =>
            item.section ? (
              <span key={i} className="eyebrow section">{item.section}</span>
            ) : (
              <Link key={item.to} to={item.to}>
                <item.icon />
                {item.label}
              </Link>
            )
          )}
        </nav>
        <div className="sidebar-foot">
          <Avatar name={user?.name} />
          <div className="grow">
            <div className="small truncate" style={{ fontWeight: 500 }}>{user?.name}</div>
            <div className="tiny faint">{user?.role}</div>
          </div>
          <button className="btn ghost icon" onClick={logout} title="Cerrar sesión" aria-label="Cerrar sesión"><I.logout /></button>
        </div>
      </aside>

      <div className="main">
        <div className="mobile-nav">
          {visible.filter((i) => !i.section).map((item) => (
            <Link key={item.to} to={item.to}>{item.label}</Link>
          ))}
        </div>
        {!isInbox && title ? (
          <div className="topbar">
            <h1>{title}</h1>
          </div>
        ) : null}
        {isInbox ? children : <div className="page">{children}</div>}
      </div>
    </div>
  );
}
