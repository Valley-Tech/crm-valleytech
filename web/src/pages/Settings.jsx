import React, { useCallback, useEffect, useState } from 'react';
import { get, post, patch, del } from '../api.js';
import { useAuth, useToast, hasRole } from '../store.jsx';
import { Button, Empty, Field, Loading, Modal } from '../components/ui.jsx';
import { I } from '../components/Icons.jsx';

export default function Settings() {
  const { user, config } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(() => get('/api/quick-replies').then((d) => setItems(d.items)).catch((e) => toast(e.message, { error: true })), [toast]);
  useEffect(() => { load(); }, [load]);

  async function remove(q) {
    if (!window.confirm(`¿Eliminar /${q.shortcut}?`)) return;
    try { await del(`/api/quick-replies/${q.id}`); load(); } catch (err) { toast(err.message, { error: true }); }
  }

  return (
    <>
      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <div><h3>Respuestas rápidas</h3><p className="small muted">En la bandeja, escribe <code>/</code> y el atajo. <code>{'{{contact.name}}'}</code> se reemplaza por el nombre del cliente.</p></div>
            <Button size="sm" variant="primary" onClick={() => setEditing({})}><I.plus /> Nueva</Button>
          </div>
          {items === null ? <Loading /> : items.length === 0 ? <Empty title="Sin respuestas rápidas" /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Atajo</th><th>Título</th><th>Texto</th><th></th></tr></thead>
                <tbody>
                  {items.map((q) => (
                    <tr key={q.id}>
                      <td className="mono">/{q.shortcut}</td>
                      <td>{q.title}</td>
                      <td className="small truncate" style={{ maxWidth: 320 }}>{q.body}</td>
                      <td><span className="row"><Button size="sm" onClick={() => setEditing(q)}>Editar</Button>{hasRole(user, 'admin') ? <Button size="sm" variant="danger" onClick={() => remove(q)}>Eliminar</Button> : null}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="col">
          <div className="card pad col">
            <h3>Tu cuenta</h3>
            <div className="small"><span className="muted">Cliente:</span> {user.tenant?.name} · <span className="muted">plan</span> {user.tenant?.plan}</div>
            <div className="small"><span className="muted">Usuario:</span> {user.name} ({user.email}) · rol {user.role}</div>
            <div className="small"><span className="muted">URL pública:</span> <code>{config?.publicUrl}</code></div>
            <div className="small"><span className="muted">Webhook de Meta:</span> <code>{config?.publicUrl}/webhooks/meta</code></div>
          </div>
          <div className="card pad col">
            <h3>Páginas legales</h3>
            <p className="small muted">Meta exige que sean públicas. Úsalas en la configuración básica de la app.</p>
            <div className="row wrap"><a className="btn sm" href="/privacidad" target="_blank" rel="noreferrer">Política de privacidad</a><a className="btn sm" href="/terminos" target="_blank" rel="noreferrer">Términos de servicio</a></div>
          </div>
        </div>
      </div>
      {editing ? <QuickReplyModal item={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} /> : null}
    </>
  );
}

function QuickReplyModal({ item, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ shortcut: item.shortcut ?? '', title: item.title ?? '', body: item.body ?? '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault(); setBusy(true);
    try {
      if (item.id) await patch(`/api/quick-replies/${item.id}`, form); else await post('/api/quick-replies', form);
      onDone();
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }
  return (
    <Modal title={item.id ? 'Editar respuesta rápida' : 'Nueva respuesta rápida'} onClose={onClose}>
      <form className="col" style={{ gap: 12 }} onSubmit={submit}>
        <Field label="Atajo" hint="Sin espacios. Se escribe /atajo en la bandeja"><input className="input mono" value={form.shortcut} onChange={set('shortcut')} required pattern="[A-Za-z0-9_\-]{2,30}" /></Field>
        <Field label="Título"><input className="input" value={form.title} onChange={set('title')} required /></Field>
        <Field label="Texto"><textarea className="textarea" value={form.body} onChange={set('body')} required /></Field>
        <div className="row end"><Button variant="primary" type="submit" loading={busy}>Guardar</Button></div>
      </form>
    </Modal>
  );
}
