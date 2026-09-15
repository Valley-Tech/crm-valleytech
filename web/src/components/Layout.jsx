import React, { useState, useEffect } from 'react';
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
  // Dentro de un chat (móvil) la barra inferior se oculta, como en WhatsApp.
  const inThread = /^\/inbox\/.+/.test(path);
  const items = visible.filter((i) => !i.section);
  const primary = items.slice(0, 4);
  const rest = items.slice(4);
  const [more, setMore] = useState(false);
  useEffect(() => { setMore(false); }, [path]);

  return (
    <div className={`shell ${inThread ? 'in-thread' : 'has-tabbar'}`}>
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
        {!isInbox && title ? (
          <div className="topbar">
            <h1>{title}</h1>
            <span className="tiny faint mobile-only">{user?.tenant?.name}</span>
          </div>
        ) : null}
        {isInbox ? children : <div className="page">{children}</div>}

        {/* Barra inferior (solo móvil) */}
        {!inThread ? (
          <nav className="tabbar" aria-label="Navegación">
            {primary.map((item) => (
              <Link key={item.to} to={item.to}><item.icon />{item.label.replace('Números de WhatsApp', 'Números')}</Link>
            ))}
            {rest.length ? (
              <a href="#mas" className={more || rest.some((r) => path.startsWith(r.to)) ? 'active' : ''} onClick={(e) => { e.preventDefault(); setMore((v) => !v); }}><I.menu />Más</a>
            ) : null}
          </nav>
        ) : null}
        {more ? (
          <div className="sheet-backdrop" onClick={() => setMore(false)}>
            <div className="sheet" onClick={(e) => e.stopPropagation()}>
              <div className="sheet-handle" />
              {rest.map((item) => (
                <Link key={item.to} to={item.to} className="sheet-item"><item.icon />{item.label}</Link>
              ))}
              <button type="button" className="sheet-item" onClick={logout}><I.logout />Cerrar sesión ({user?.name})</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
