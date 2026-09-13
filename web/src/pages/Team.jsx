import React, { useCallback, useEffect, useState } from 'react';
import { get, post, patch } from '../api.js';
import { useAuth, useToast } from '../store.jsx';
import { Avatar, Badge, Button, Field, Loading, Modal, Switch, fmtDateTime } from '../components/ui.jsx';
import { I } from '../components/Icons.jsx';

const ROLES = { owner: 'Dueño', admin: 'Administrador', agent: 'Agente', viewer: 'Lector' };

export default function Team() {
  const { user: me } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = useCallback(() => get('/api/users').then((d) => setItems(d.items)).catch((e) => toast(e.message, { error: true })), [toast]);
  useEffect(() => { load(); }, [load]);

  async function update(u, data) {
    try {
      const updated = await patch(`/api/users/${u.id}`, data);
      setItems((list) => list.map((x) => (x.id === updated.id ? updated : x)));
      toast('Usuario actualizado');
    } catch (err) { toast(err.message, { error: true }); }
  }

  return (
    <>
      <div className="page-head">
        <p>Dueño y administradores configuran todo; los agentes atienden la bandeja; los lectores solo miran.</p>
        <Button id="new-user" variant="primary" onClick={() => setCreating(true)}><I.plus /> Nuevo usuario</Button>
      </div>
      {items === null ? <Loading /> : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Usuario</th><th>Correo</th><th>Rol</th><th>Activo</th><th>Último acceso</th><th></th></tr></thead>
            <tbody>
              {items.map((u) => (
                <tr key={u.id}>
                  <td><span className="row"><Avatar name={u.name} /> {u.name}{u.id === me.id ? <Badge>tú</Badge> : null}</span></td>
                  <td>{u.email}</td>
                  <td>
                    <select className="select" value={u.role} disabled={u.id === me.id} onChange={(e) => update(u, { role: e.target.value })}>
                      {Object.entries(ROLES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </td>
                  <td><Switch on={u.active} disabled={u.id === me.id} onChange={(v) => update(u, { active: v })} /></td>
                  <td className="small">{fmtDateTime(u.lastLoginAt)}</td>
                  <td><Button size="sm" onClick={() => setEditing(u)}>Cambiar contraseña</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating ? <UserModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} /> : null}
      {editing ? <PasswordModal user={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function UserModal({ onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'agent' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault(); setBusy(true);
    try { await post('/api/users', form); toast('Usuario creado'); onDone(); } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }
  return (
    <Modal title="Nuevo usuario" onClose={onClose}>
      <form className="col" style={{ gap: 12 }} onSubmit={submit}>
        <Field label="Nombre"><input className="input" value={form.name} onChange={set('name')} required minLength={2} /></Field>
        <Field label="Correo"><input className="input" type="email" value={form.email} onChange={set('email')} required /></Field>
        <Field label="Contraseña" hint="Mínimo 10 caracteres"><input className="input" type="password" value={form.password} onChange={set('password')} required minLength={10} /></Field>
        <Field label="Rol"><select className="select" value={form.role} onChange={set('role')}>{Object.entries(ROLES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <div className="row end"><Button variant="primary" type="submit" loading={busy}>Crear</Button></div>
      </form>
    </Modal>
  );
}

function PasswordModal({ user, onClose }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true);
    try { await patch(`/api/users/${user.id}`, { password }); toast('Contraseña actualizada'); onClose(); } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Contraseña de ${user.name}`} onClose={onClose}>
      <form className="col" style={{ gap: 12 }} onSubmit={submit}>
        <Field label="Nueva contraseña" hint="Mínimo 10 caracteres"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} /></Field>
        <div className="row end"><Button variant="primary" type="submit" loading={busy}>Guardar</Button></div>
      </form>
    </Modal>
  );
}
