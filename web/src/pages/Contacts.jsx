import React, { useCallback, useEffect, useState } from 'react';
import { get, patch } from '../api.js';
import { useRouter } from '../router.jsx';
import { useAuth, useToast, hasRole } from '../store.jsx';
import { Avatar, Badge, Button, Empty, Field, Loading, Modal, fmtDateTime, fmtPhone, CONV_STATUS } from '../components/ui.jsx';

export default function Contacts({ params }) {
  const { navigate } = useRouter();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [data, setData] = useState(null);
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const load = useCallback(() => {
    const qs = [`limit=${limit}`, `offset=${offset}`, q ? `q=${encodeURIComponent(q)}` : '', tag ? `tag=${encodeURIComponent(tag)}` : ''].filter(Boolean).join('&');
    get(`/api/contacts?${qs}`).then(setData).catch((e) => toast(e.message, { error: true }));
  }, [q, tag, offset, toast]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="page-head">
        <div className="row wrap">
          <input id="contacts-search" className="input" style={{ width: 280 }} type="search" placeholder="Buscar por nombre o número" value={q} onChange={(e) => { setOffset(0); setQ(e.target.value); }} />
          <input className="input" style={{ width: 180 }} placeholder="Filtrar por etiqueta" value={tag} onChange={(e) => { setOffset(0); setTag(e.target.value.trim().toLowerCase()); }} />
        </div>
        <span className="muted small">{data ? `${data.total} contactos` : ''}</span>
      </div>

      {!data ? <Loading /> : data.items.length === 0 ? (
        <div className="card"><Empty title="Sin contactos">Se crean solos cuando alguien escribe a un número conectado.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Contacto</th><th>Número</th><th>Etiquetas</th><th>Correo</th><th>Última actividad</th></tr></thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id} className="click" onClick={() => navigate(`/contacts/${c.id}`)}>
                  <td><span className="row"><Avatar name={c.name || c.waId} /> <span>{c.name || <span className="muted">Sin nombre</span>}</span></span></td>
                  <td className="mono">{fmtPhone(c.waId)}</td>
                  <td><span className="chips">{(c.tags ?? []).map((t) => <span key={t} className="tag">{t}</span>)}</span></td>
                  <td>{c.email ?? '—'}</td>
                  <td className="small">{fmtDateTime(c.updatedAt)}</td>
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

      {params.contactId ? <ContactDetail id={params.contactId} onClose={() => { navigate('/contacts'); load(); }} /> : null}
    </>
  );
}

function ContactDetail({ id, onClose }) {
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
    <Modal title={c.name || fmtPhone(c.waId)} onClose={onClose} footer={canWrite ? <Button variant="primary" onClick={save}>Guardar</Button> : null}>
      <div className="row"><Avatar name={c.name || c.waId} size="lg" /><div><div className="mono">{fmtPhone(c.waId)}</div><div className="tiny faint">{c.messageCount} mensajes · desde {fmtDateTime(c.createdAt)}</div></div></div>
      <Field label="Nombre"><input className="input" value={form.name} disabled={!canWrite} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></Field>
      <Field label="Correo"><input className="input" type="email" value={form.email} disabled={!canWrite} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></Field>
      <Field label="Etiquetas" hint="Separadas por coma"><input className="input" value={form.tags} disabled={!canWrite} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))} /></Field>
      <div>
        <span className="label">Conversaciones</span>
        <div className="col" style={{ marginTop: 6 }}>
          {c.conversations.map((conv) => (
            <button key={conv.id} className="card pad row between" style={{ cursor: 'pointer', font: 'inherit', textAlign: 'left' }} onClick={() => navigate(`/inbox/${conv.id}`)}>
              <span className="truncate small">{conv.lastMessagePreview || '—'}</span>
              <span className="row"><Badge>{CONV_STATUS[conv.status]}</Badge><span className="tiny faint">{fmtDateTime(conv.lastMessageAt)}</span></span>
            </button>
          ))}
          {c.conversations.length === 0 ? <span className="small faint">Sin conversaciones</span> : null}
        </div>
      </div>
    </Modal>
  );
}
