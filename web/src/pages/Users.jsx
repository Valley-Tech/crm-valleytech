import React, { useCallback, useEffect, useState } from 'react';
import { get, post, patch, del } from '../api.js';
import { useAuth, useToast, isSuperAdmin } from '../store.jsx';
import { Avatar, Badge, Button, Confirm, Empty, Field, Loading, Modal, Switch, fmtDateTime } from '../components/ui.jsx';
import { I } from '../components/Icons.jsx';

/**
 * Usuarios (antes "Equipo"): quién entra al CRM y qué chatbot (número de
 * WhatsApp) administra. Todo lo que ve un usuario que no es SuperAdmin
 * —bandeja, contactos, campañas, plantillas, dashboard— se limita a los
 * números marcados aquí.
 */

const ROLE_HELP = [
  ['SuperAdmin', 'Dueño del CRM. Ve y configura todo: números, chatbots, usuarios y ajustes.'],
  ['Administrador', 'Como el Dueño y, además, crea y gestiona los usuarios de sus chatbots.'],
  ['Dueño', 'Dueño de un chatbot: bandeja, contactos, campañas, plantillas y dashboard de sus números.'],
  ['Agente', 'Atiende la bandeja de sus números (no crea campañas).'],
  ['Lector', 'Solo mira.'],
];

const numberLabel = (i) => (i.bots?.length ? i.bots.map((b) => b.name).join(', ') : i.verifiedName || 'Sin chatbot');

export default function Users() {
  const { user: me } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [options, setOptions] = useState({ integrations: [], roles: [] });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [password, setPassword] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([get('/api/users'), get('/api/users/options')])
      .then(([u, o]) => { setItems(u.items); setOptions(o); })
      .catch((e) => toast(e.message, { error: true }));
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  async function update(u, data) {
    try {
      const updated = await patch(`/api/users/${u.id}`, data);
      setItems((list) => list.map((x) => (x.id === updated.id ? updated : x)));
      toast('Usuario actualizado');
    } catch (err) { toast(err.message, { error: true }); }
  }

  async function remove() {
    setBusy(true);
    try {
      await del(`/api/users/${removing.id}`);
      setItems((list) => list.filter((x) => x.id !== removing.id));
      toast(`Usuario ${removing.name} eliminado`);
      setRemoving(null);
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }

  const superAdmin = isSuperAdmin(me);

  return (
    <>
      <div className="page-head">
        <p>
          {superAdmin
            ? 'Cada usuario ve solo los chatbots (números de WhatsApp) que le asignes aquí. Tú, como SuperAdmin, lo ves todo.'
            : 'Aquí gestionas a las personas que trabajan con tus chatbots. Solo puedes asignarles los números que tú administras.'}
        </p>
        <Button id="new-user" variant="primary" onClick={() => setCreating(true)}><I.plus /> Nuevo usuario</Button>
      </div>

      {items === null ? <Loading /> : items.length === 0 ? (
        <div className="card"><Empty title="Todavía no hay usuarios" icon={<I.team />}>Crea el primero y asígnale su chatbot.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Usuario</th><th>Rol</th><th>Chatbots / números</th><th>Activo</th><th>Último acceso</th><th></th></tr></thead>
            <tbody>
              {items.map((u) => {
                const self = u.id === me.id;
                const locked = self || (u.role === 'superadmin' && !superAdmin);
                return (
                  <tr key={u.id}>
                    <td>
                      <span className="row"><Avatar name={u.name} /><span className="col" style={{ gap: 0 }}><span>{u.name}{self ? <Badge>tú</Badge> : null}</span><span className="tiny faint">{u.email}</span></span></span>
                    </td>
                    <td>
                      {u.role === 'superadmin' ? <Badge tone="accent">SuperAdmin</Badge> : (
                        <select className="select" value={u.role} disabled={locked} onChange={(e) => update(u, { role: e.target.value })}>
                          {options.roles.filter((r) => r.value !== 'superadmin').map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                      )}
                    </td>
                    <td>
                      {u.role === 'superadmin' ? <span className="small muted">Todos</span> : u.integrations.length === 0 ? <Badge tone="warn">sin asignar</Badge> : (
                        <span className="col" style={{ gap: 2 }}>
                          {u.integrations.map((i) => (
                            <span key={i.id} className="small"><strong>{numberLabel(i)}</strong> <span className="mono faint tiny">{i.displayPhoneNumber}</span></span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td><Switch on={u.active} disabled={locked} onChange={(v) => update(u, { active: v })} /></td>
                    <td className="small">{fmtDateTime(u.lastLoginAt)}</td>
                    <td>
                      <span className="row" style={{ justifyContent: 'flex-end' }}>
                        <Button size="sm" onClick={() => setEditing(u)} disabled={u.role === 'superadmin' && !superAdmin}>Editar</Button>
                        <Button size="sm" onClick={() => setPassword(u)} disabled={u.role === 'superadmin' && !superAdmin}>Contraseña</Button>
                        {!self ? <Button size="sm" variant="danger" onClick={() => setRemoving(u)} disabled={locked}>Eliminar</Button> : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card pad">
        <h3 style={{ marginBottom: 8 }}>Qué puede hacer cada rol</h3>
        <div className="role-help">
          {ROLE_HELP.map(([r, d]) => <React.Fragment key={r}><strong>{r}</strong><span>{d}</span></React.Fragment>)}
        </div>
      </div>

      {creating ? <UserModal options={options} onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} /> : null}
      {editing ? <UserModal options={options} user={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} /> : null}
      {password ? <PasswordModal user={password} onClose={() => setPassword(null)} /> : null}
      {removing ? (
        <Confirm title={`¿Eliminar a ${removing.name}?`} confirmLabel="Eliminar usuario" danger busy={busy} onConfirm={remove} onClose={() => setRemoving(null)}>
          Dejará de poder entrar al CRM. Sus chats, mensajes y notas se conservan (quedan sin autor). Si solo quieres bloquear el acceso temporalmente, desactívalo en vez de eliminarlo.
        </Confirm>
      ) : null}
    </>
  );
}

function UserModal({ options, user, onClose, onDone }) {
  const toast = useToast();
  const editing = Boolean(user);
  const [form, setForm] = useState({
    name: user?.name ?? '',
    email: user?.email ?? '',
    password: '',
    role: user?.role ?? 'owner',
    integrationIds: user?.integrations?.map((i) => i.id) ?? [],
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (id) => setForm((f) => ({ ...f, integrationIds: f.integrationIds.includes(id) ? f.integrationIds.filter((x) => x !== id) : [...f.integrationIds, id] }));

  const needsNumbers = form.role !== 'superadmin';
  const valid = form.name.trim().length >= 2 && (editing || (form.email && form.password.length >= 10)) && (!needsNumbers || form.integrationIds.length > 0);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      if (editing) {
        await patch(`/api/users/${user.id}`, { name: form.name, role: form.role, integrationIds: needsNumbers ? form.integrationIds : [] });
        toast('Usuario actualizado');
      } else {
        await post('/api/users', { ...form, integrationIds: needsNumbers ? form.integrationIds : [] });
        toast('Usuario creado');
      }
      onDone();
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }

  const roles = options.roles;

  return (
    <Modal title={editing ? `Editar a ${user.name}` : 'Nuevo usuario'} onClose={onClose}>
      <form className="col" style={{ gap: 12 }} onSubmit={submit}>
        <Field label="Nombre"><input className="input" value={form.name} onChange={set('name')} required minLength={2} placeholder="Nelson Pérez" /></Field>
        {!editing ? (
          <>
            <Field label="Correo"><input className="input" type="email" value={form.email} onChange={set('email')} required placeholder="nelson@samuelito.com" /></Field>
            <Field label="Contraseña" hint="Mínimo 10 caracteres. Compártela con el dueño; podrá cambiarla después."><input className="input" type="password" value={form.password} onChange={set('password')} required minLength={10} /></Field>
          </>
        ) : null}
        <Field label="Rol">
          <select className="select" value={form.role} onChange={set('role')} disabled={editing && user.role === 'superadmin'}>
            {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </Field>
        {needsNumbers ? (
          <Field label="Chatbots que administra" hint="Solo verá la bandeja, los contactos, las campañas y las plantillas de estos números.">
            {options.integrations.length === 0 ? <p className="small muted">No hay números conectados que asignar.</p> : (
              <div className="chk-list">
                {options.integrations.map((i) => (
                  <label key={i.id} className={form.integrationIds.includes(i.id) ? 'on' : ''}>
                    <input type="checkbox" checked={form.integrationIds.includes(i.id)} onChange={() => toggle(i.id)} />
                    <span className="who"><span>{numberLabel(i)}{!i.active ? <Badge tone="crit">inactivo</Badge> : null}</span><small>{i.displayPhoneNumber}{i.verifiedName ? ` · ${i.verifiedName}` : ''}</small></span>
                  </label>
                ))}
              </div>
            )}
          </Field>
        ) : <p className="small muted">Un SuperAdmin ve todos los chatbots y toda la configuración.</p>}
        <div className="row end"><Button variant="primary" type="submit" loading={busy} disabled={!valid}>{editing ? 'Guardar' : 'Crear usuario'}</Button></div>
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
