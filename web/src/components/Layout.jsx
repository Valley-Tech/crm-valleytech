import React, { useState, useEffect } from 'react';
import { Link, useRouter } from '../router.jsx';
import { useAuth, hasRole, roleLabel, scopeLabel } from '../store.jsx';
import { Avatar } from './ui.jsx';
import { I } from './Icons.jsx';

/**
 * Menú por rol. Cada sección solo aparece si tiene al menos una entrada
 * visible: un Dueño no ve "Configuración" (que es solo del SuperAdmin) y un
 * Administrador solo ve en ella "Usuarios".
 */
const NAV = [
  { section: 'Operación' },
  { to: '/inbox', label: 'Bandeja', icon: I.inbox, role: 'viewer' },
  { to: '/contacts', label: 'Contactos', icon: I.contacts, role: 'viewer' },
  { to: '/campaigns', label: 'Campañas', icon: I.campaigns, role: 'owner' },
  { to: '/templates', label: 'Plantillas', icon: I.templates, role: 'viewer' },
  { section: 'Análisis' },
  { to: '/dashboard', label: 'Dashboard', icon: I.dashboard, role: 'viewer' },
  { section: 'Configuración' },
  { to: '/numbers', label: 'Números de WhatsApp', icon: I.numbers, role: 'superadmin' },
  { to: '/bots', label: 'Chatbots', icon: I.bots, role: 'superadmin' },
  { to: '/users', label: 'Usuarios', icon: I.team, role: 'admin' },
  { to: '/settings', label: 'Ajustes', icon: I.settings, role: 'superadmin' },
];

/** Quita las secciones que quedaron sin entradas para este usuario. */
function navFor(user) {
  const out = [];
  for (const item of NAV) {
    if (item.section) {
      out.push(item);
      continue;
    }
    if (hasRole(user, item.role)) out.push(item);
  }
  return out.filter((item, i) => !item.section || (out[i + 1] && !out[i + 1].section));
}

export function Layout({ children, title }) {
  const { user, logout } = useAuth();
  const { path } = useRouter();
  const visible = navFor(user);
  const isInbox = path.startsWith('/inbox');
  // Dentro de un chat (móvil) la barra inferior se oculta, como en WhatsApp.
  const inThread = /^\/inbox\/.+/.test(path);
  const items = visible.filter((i) => !i.section);
  const primary = items.slice(0, 4);
  const rest = items.slice(4);
  const [more, setMore] = useState(false);
  useEffect(() => { setMore(false); }, [path]);

  const scoped = user && !user.scope?.all;
  const scopeText = scopeLabel(user);

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
        {scoped ? (
          <div className="scope-box" title={scopeText}>
            <span className="eyebrow">Estás administrando</span>
            <strong className="truncate">{scopeText}</strong>
            {(user.scope?.integrations ?? []).map((i) => (
              <span key={i.id} className="tiny faint mono truncate">{i.displayPhoneNumber}</span>
            ))}
            {!(user.scope?.integrations ?? []).length ? <span className="tiny faint">Pide al SuperAdmin que te asigne un chatbot.</span> : null}
          </div>
        ) : null}
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
            <div className="tiny faint">{roleLabel(user?.role)}</div>
          </div>
          <button className="btn ghost icon" onClick={logout} title="Cerrar sesión" aria-label="Cerrar sesión"><I.logout /></button>
        </div>
      </aside>

      <div className="main">
        {!isInbox && title ? (
          <div className="topbar">
            <h1>{title}</h1>
            <span className="tiny faint mobile-only truncate">{scoped ? scopeText : user?.tenant?.name}</span>
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
              {scoped ? <div className="sheet-item static"><span className="tiny faint">Administrando</span><strong className="small">{scopeText}</strong></div> : null}
              {rest.map((item) => (
                <Link key={item.to} to={item.to} className="sheet-item"><item.icon />{item.label}</Link>
              ))}
              <button type="button" className="sheet-item" onClick={logout}><I.logout />Cerrar sesión ({user?.name} · {roleLabel(user?.role)})</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
