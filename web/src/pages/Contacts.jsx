import React, { useCallback, useEffect, useState } from 'react';
import { get, patch, del, post } from '../api.js';
import { useRouter } from '../router.jsx';
import { useAuth, useToast, hasRole } from '../store.jsx';
import { Avatar, Badge, Button, Empty, Field, Loading, Modal, Menu, Confirm, ChannelTag, fmtDateTime, fmtPhone, CONV_STATUS } from '../components/ui.jsx';
import { I } from '../components/Icons.jsx';

/**
 * Contactos.
 *
 * - Cada fila dice por qué chatbot / número llegó el contacto (etiqueta de color).
 * - "Sin nombre" se corrige en el momento (Poner nombre) sin abrir la ficha.
 * - Se puede eliminar un contacto o varios (selección), con confirmación,
 *   igual que "Eliminar chat" en la bandeja.
 */
export default function Contacts({ params }) {
  const { user } = useAuth();
  const { navigate } = useRouter();
  const toast = useToast();
  const canWrite = hasRole(user, 'agent');
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [data, setData] = useState(null);
  const [offset, setOffset] = useState(0);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [confirm, setConfirm] = useState(null); // { ids, label }
  const [rename, setRename] = useState(null);   // contacto a renombrar
  const [busy, setBusy] = useState(false);
  const limit = 50;

  const load = useCallback(() => {
    const qs = [`limit=${limit}`, `offset=${offset}`, q ? `q=${encodeURIComponent(q)}` : '', tag ? `tag=${encodeURIComponent(tag)}` : ''].filter(Boolean).join('&');
    get(`/api/contacts?${qs}`).then(setData).catch((e) => toast(e.message, { error: true }));
  }, [q, tag, offset, toast]);
  useEffect(() => { load(); }, [load]);

  const labelOf = (c) => c.name || fmtPhone(c.waId);

  function toggle(id) {
    setSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }
  function exitSelect() { setSelectMode(false); setSelected(new Set()); }

  async function runDelete() {
    if (!confirm) return;
    setBusy(true);
    try {
      const r = confirm.ids.length === 1
        ? await del(`/api/contacts/${confirm.ids[0]}`)
        : await post('/api/contacts/bulk-delete', { ids: confirm.ids });
      toast(r.deleted === 1 ? `Contacto eliminado (${r.conversations} chat${r.conversations === 1 ? '' : 's'})` : `${r.deleted} contactos eliminados`);
      setConfirm(null);
      exitSelect();
      load();
    } catch (err) {
      toast(err.message, { error: true });
    } finally { setBusy(false); }
  }

  function onRenamed(updated) {
    setData((d) => (d ? { ...d, items: d.items.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)) } : d));
  }

  return (
    <>
      <div className="page-head">
        <div className="row wrap">
          <input id="contacts-search" className="input" style={{ width: 280 }} type="search" placeholder="Buscar por nombre o número" value={q} onChange={(e) => { setOffset(0); setQ(e.target.value); }} />
          <input className="input" style={{ width: 180 }} placeholder="Filtrar por etiqueta" value={tag} onChange={(e) => { setOffset(0); setTag(e.target.value.trim().toLowerCase()); }} />
        </div>
        <div className="row" style={{ gap: 8 }}>
          {selectMode ? (
            <>
              <span className="small muted">{selected.size} seleccionado{selected.size === 1 ? '' : 's'}</span>
              <Button size="sm" onClick={() => setSelected(new Set((data?.items ?? []).map((c) => c.id)))}>Todos</Button>
              <Button size="sm" variant="danger" disabled={selected.size === 0} onClick={() => setConfirm({ ids: [...selected] })}><I.trash /> Eliminar</Button>
              <Button size="sm" variant="ghost" onClick={exitSelect}>Cancelar</Button>
            </>
          ) : (
            <>
              <span className="muted small">{data ? `${data.total} contactos` : ''}</span>
              {canWrite && data?.items?.length ? (
                <Button size="sm" onClick={() => setSelectMode(true)}><I.checkSquare /> Seleccionar</Button>
              ) : null}
            </>
          )}
        </div>
      </div>

      {!data ? <Loading /> : data.items.length === 0 ? (
        <div className="card"><Empty title="Sin contactos">Se crean solos cuando alguien escribe a un número conectado.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                {selectMode ? <th className="sel" /> : null}
                <th>Contacto</th><th>Número</th><th>Chatbot / número</th><th>Etiquetas</th><th>Correo</th><th>Última actividad</th>
                {canWrite && !selectMode ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => (
                <tr
                  key={c.id}
                  className={`click ${selected.has(c.id) ? 'selected' : ''}`}
                  onClick={() => (selectMode ? toggle(c.id) : navigate(`/contacts/${c.id}`))}
                >
                  {selectMode ? (
                    <td className="sel"><span className={`select-dot ${selected.has(c.id) ? 'on' : ''}`} aria-hidden="true">{selected.has(c.id) ? <I.check /> : null}</span></td>
                  ) : null}
                  <td>
                    <span className="row"><Avatar name={c.name || c.waId} />
                      {c.name ? <span>{c.name}</span> : (
                        <span className="name-missing">Sin nombre
                          {canWrite ? <button type="button" className="btn ghost sm" onClick={(e) => { e.stopPropagation(); setRename(c); }}>Poner nombre</button> : null}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="mono">{fmtPhone(c.waId)}</td>
                  <td>{c.integration || c.bot ? <ChannelTag bot={c.bot} integration={c.integration} /> : <span className="faint small">—</span>}</td>
                  <td><span className="chips">{(c.tags ?? []).map((t) => <span key={t} className="tag">{t}</span>)}</span></td>
                  <td>{c.email ?? '—'}</td>
                  <td className="small">{fmtDateTime(c.updatedAt)}</td>
                  {canWrite && !selectMode ? (
                    <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <Menu
                        trigger={<button type="button" className="btn ghost icon sm" aria-label="Opciones del contacto"><I.more /></button>}
                        items={[
                          { label: c.conversationId ? 'Abrir chat' : 'Sin chats', icon: <I.inbox />, disabled: !c.conversationId, onClick: () => navigate(`/inbox/${c.conversationId}`) },
                          { label: c.name ? 'Cambiar nombre' : 'Poner nombre', icon: <I.user />, onClick: () => setRename(c) },
                          { label: 'Ver ficha', icon: <I.info />, onClick: () => navigate(`/contacts/${c.id}`) },
                          { label: 'Seleccionar', icon: <I.checkSquare />, onClick: () => { setSelectMode(true); setSelected(new Set([c.id])); } },
                          { divider: true },
                          { label: 'Eliminar contacto', icon: <I.trash />, onClick: () => setConfirm({ ids: [c.id], label: labelOf(c) }), danger: true },
                        ]}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > limit ? (
        <div className="row end">
          <Button size="sm" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - limit))}>← Anteriores</Button>
          <span className="small muted">{offset + 1}–{Math.min(offset + limit, data.total)} de {data.total}</span>
          <Button size="sm" disabled={offset + limit >= data.total} onClick={() => setOffset((o) => o + limit)}>Siguientes →</Button>
        </div>
      ) : null}

      {params.contactId ? (
        <ContactDetail
          id={params.contactId}
          onClose={() => { navigate('/contacts'); load(); }}
          onDelete={(c) => { navigate('/contacts'); setConfirm({ ids: [c.id], label: labelOf(c) }); }}
        />
      ) : null}

      {rename ? <RenameModal contact={rename} onClose={() => setRename(null)} onSaved={(u) => { onRenamed(u); setRename(null); }} /> : null}

      {confirm ? (
        <Confirm
          title={confirm.ids.length > 1 ? `¿Eliminar ${confirm.ids.length} contactos?` : `¿Eliminar a ${confirm.label}?`}
          confirmLabel={confirm.ids.length > 1 ? `Eliminar ${confirm.ids.length} contactos` : 'Eliminar contacto'}
          danger
          busy={busy}
          onConfirm={runDelete}
          onClose={() => setConfirm(null)}
        >
          Se eliminan {confirm.ids.length > 1 ? 'los contactos' : 'el contacto'}, <strong>todos sus chats</strong> (mensajes, archivos y notas internas) y su rastro en campañas. No afecta al WhatsApp del cliente ni a Meta. Si vuelve a escribir, se creará de nuevo como contacto sin nombre.
        </Confirm>
      ) : null}
    </>
  );
}

/* ========================================================================== */
function RenameModal({ contact, onClose, onSaved }) {
  const toast = useToast();
  const [name, setName] = useState(contact.name ?? '');
  const [busy, setBusy] = useState(false);

  async function save(e) {
    e?.preventDefault();
    setBusy(true);
    try {
      const updated = await patch(`/api/contacts/${contact.id}`, { name: name.trim() });
      toast(name.trim() ? 'Nombre guardado' : 'Nombre quitado');
      onSaved(updated);
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }

  return (
    <Modal title={contact.name ? 'Cambiar nombre' : 'Poner nombre'} onClose={onClose} footer={
      <div className="row end" style={{ gap: 8 }}>
        <Button type="button" onClick={onClose}>Cancelar</Button>
        <Button type="submit" form="rename-form" variant="primary" loading={busy}>Guardar</Button>
      </div>
    }>
      <form id="rename-form" onSubmit={save} className="col">
        <div className="row"><Avatar name={name || contact.waId} /><span className="mono">{fmtPhone(contact.waId)}</span></div>
        <Field label="Nombre" hint="Es el nombre que verás en la bandeja y en los contactos. El cliente no lo ve.">
          <input className="input" autoFocus value={name} placeholder="Ej. María Pérez" maxLength={160} onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

/* ========================================================================== */
function ContactDetail({ id, onClose, onDelete }) {
  const { user } = useAuth();
  const { navigate } = useRouter();
  const toast = useToast();
  const [c, setC] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', tags: '' });
  const canWrite = hasRole(user, 'agent');

  useEffect(() => {
    get(`/api/contacts/${id}`).then((d) => { setC(d); setForm({ name: d.name ?? '', email: d.email ?? '', tags: (d.tags ?? []).join(', ') }); }).catch((e) => { toast(e.message, { error: true }); onClose(); });
  }, [id, toast, onClose]);

  async function save() {
    try {
      const updated = await patch(`/api/contacts/${id}`, {
        name: form.name.trim(),
        email: form.email.trim() || null,
        tags: form.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
      });
      setC((x) => ({ ...x, ...updated }));
      toast('Contacto guardado');
    } catch (err) { toast(err.message, { error: true }); }
  }

  if (!c) return <Modal title="Contacto" onClose={onClose}><Loading /></Modal>;

  return (
    <Modal
      title={c.name || fmtPhone(c.waId)}
      onClose={onClose}
      footer={canWrite ? (
        <div className="row between" style={{ width: '100%' }}>
          <Button variant="danger" onClick={() => onDelete(c)}><I.trash /> Eliminar contacto</Button>
          <Button variant="primary" onClick={save}>Guardar</Button>
        </div>
      ) : null}
    >
      <div className="row"><Avatar name={c.name || c.waId} size="lg" /><div><div className="mono">{fmtPhone(c.waId)}</div><div className="tiny faint">{c.messageCount} mensajes · desde {fmtDateTime(c.createdAt)}</div></div></div>
      <Field label="Nombre"><input className="input" value={form.name} placeholder="Sin nombre" disabled={!canWrite} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></Field>
      <Field label="Correo"><input className="input" type="email" value={form.email} disabled={!canWrite} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></Field>
      <Field label="Etiquetas" hint="Separadas por coma"><input className="input" value={form.tags} disabled={!canWrite} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))} /></Field>
      <div>
        <span className="label">Conversaciones</span>
        <div className="col" style={{ marginTop: 6 }}>
          {c.conversations.map((conv) => (
            <button key={conv.id} className="card pad row between" style={{ cursor: 'pointer', font: 'inherit', textAlign: 'left' }} onClick={() => navigate(`/inbox/${conv.id}`)}>
              <span className="col" style={{ minWidth: 0, gap: 4 }}>
                <ChannelTag bot={conv.bot} integration={conv.integration} />
                <span className="truncate small">{conv.lastMessagePreview || '—'}</span>
              </span>
              <span className="row" style={{ flex: 'none' }}><Badge>{CONV_STATUS[conv.status]}</Badge><span className="tiny faint">{fmtDateTime(conv.lastMessageAt)}</span></span>
            </button>
          ))}
          {c.conversations.length === 0 ? <span className="small faint">Sin conversaciones</span> : null}
        </div>
      </div>
    </Modal>
  );
}
