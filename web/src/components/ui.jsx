import React, { useEffect, useRef, useState } from 'react';

export function Button({ variant = '', size = '', className = '', loading = false, children, ...rest }) {
  return (
    <button className={`btn ${variant} ${size} ${className}`.trim()} disabled={loading || rest.disabled} {...rest}>
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Badge({ tone = '', mono = false, children }) {
  return <span className={`badge ${tone} ${mono ? 'mono' : ''}`.trim()}>{children}</span>;
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      {label ? <span className="label">{label}</span> : null}
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Switch({ on, onChange, label, disabled = false }) {
  return (
    <span className="row">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`switch ${on ? 'on' : ''}`}
        onClick={() => !disabled && onChange(!on)}
        disabled={disabled}
      />
      {label ? <span className="small">{label}</span> : null}
    </span>
  );
}

export function Modal({ title, onClose, children, footer, wide = false }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Empty({ title, children, icon = null }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children ? <p className="small">{children}</p> : null}
    </div>
  );
}

export function Loading({ label = 'Cargando…' }) {
  return (
    <div className="empty">
      <span className="spinner" />
      <p className="small">{label}</p>
    </div>
  );
}

export function Tabs({ value, onChange, items }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button key={item.value} role="tab" aria-selected={value === item.value} className={value === item.value ? 'active' : ''} onClick={() => onChange(item.value)}>
          {item.label}
          {item.count != null ? <span className="badge" style={{ marginLeft: 6 }}>{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Chips({ value, onChange, items }) {
  return (
    <div className="chips">
      {items.map((item) => (
        <button key={item.value} className={`chip ${value === item.value ? 'active' : ''}`} onClick={() => onChange(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Avatar({ name, size = '' }) {
  const initials = (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return <span className={`avatar ${size}`}>{initials || '?'}</span>;
}

export function Progress({ parts, total }) {
  const safe = Math.max(total, 1);
  return (
    <div className="progress" role="img" aria-label="Progreso">
      {parts.map((p) => (
        <span key={p.key} style={{ width: `${(p.value / safe) * 100}%`, background: p.color }} title={`${p.label}: ${p.value}`} />
      ))}
    </div>
  );
}

/* ---------- utilidades de formato compartidas ---------- */
export function fmtTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
}
export function fmtDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export function fmtDuration(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}
export function fmtPhone(waId) {
  if (!waId) return '';
  const s = String(waId);
  return s.startsWith('57') && s.length === 12 ? `+57 ${s.slice(2, 5)} ${s.slice(5, 8)} ${s.slice(8)}` : `+${s}`;
}
export const STATUS_LABEL = { queued: 'en cola', sent: 'enviado', delivered: 'entregado', read: 'leído', failed: 'falló', received: 'recibido' };
export const CONV_STATUS = { open: 'abierta', pending: 'pendiente', closed: 'cerrada' };
export const STAGES = ['nuevo', 'contactado', 'calificado', 'negociacion', 'ganado', 'perdido'];

/**
 * Menú desplegable (⋮). Se cierra al hacer clic fuera o con Escape.
 * items: [{ label, icon, onClick, danger, disabled, divider }]
 */
export function Menu({ trigger, items, align = 'right', label = 'Más opciones' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <span className="menu-wrap" ref={ref}>
      <span onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} aria-haspopup="menu" aria-expanded={open} aria-label={label} role="button">
        {trigger}
      </span>
      {open ? (
        <div className={`menu ${align}`} role="menu" onClick={(e) => e.stopPropagation()}>
          {items.filter(Boolean).map((it, i) =>
            it.divider ? <div key={i} className="menu-divider" /> : (
              <button key={i} type="button" role="menuitem" className={`menu-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled} onClick={() => { setOpen(false); it.onClick?.(); }}>
                {it.icon ? <span className="menu-icon">{it.icon}</span> : null}
                <span>{it.label}</span>
              </button>
            )
          )}
        </div>
      ) : null}
    </span>
  );
}

/** Diálogo de confirmación (como la hoja de WhatsApp al eliminar un chat). */
export function Confirm({ title, children, confirmLabel = 'Confirmar', danger = false, busy = false, onConfirm, onClose }) {
  return (
    <Modal title={title} onClose={onClose} footer={
      <div className="row end" style={{ gap: 8 }}>
        <Button type="button" onClick={onClose}>Cancelar</Button>
        <Button type="button" variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    }>
      <div className="small" style={{ lineHeight: 1.5 }}>{children}</div>
    </Modal>
  );
}

/** true cuando la ventana cumple el media query (para decidir vistas móviles en JS). */
export function useMediaQuery(query) {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
    return () => { mq.removeEventListener ? mq.removeEventListener('change', onChange) : mq.removeListener(onChange); };
  }, [query]);
  return matches;
}

export const MOBILE_QUERY = '(max-width: 860px)';
