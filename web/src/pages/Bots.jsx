import React, { useCallback, useEffect, useState } from 'react';
import { get, post, patch, del } from '../api.js';
import { useAuth, useToast } from '../store.jsx';
import { useRouter } from '../router.jsx';
import { Badge, Button, Empty, Field, Loading, Modal, Switch, fmtDateTime } from '../components/ui.jsx';
import { I } from '../components/Icons.jsx';

export default function Bots() {
  const { config } = useAuth();
  const { navigate } = useRouter();
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [numbers, setNumbers] = useState([]);
  const [creating, setCreating] = useState(false);
  const [creds, setCreds] = useState(null);

  const load = useCallback(() => get('/api/bots').then((d) => setItems(d.items)).catch((e) => toast(e.message, { error: true })), [toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { get('/api/integrations').then((d) => setNumbers(d.items)).catch(() => setNumbers([])); }, []);

  const numberLabel = (id) => {
    if (!id) return 'todos los números';
    const n = numbers.find((x) => x.id === id);
    return n ? `${n.displayPhoneNumber || n.phoneNumberId} · ${n.verifiedName || ''}` : id;
  };
  async function assign(bot, metaIntegrationId) {
    try { const u = await patch(`/api/bots/${bot.id}`, { metaIntegrationId: metaIntegrationId || null }); setItems((l) => l.map((b) => (b.id === u.id ? u : b))); } catch (err) { toast(err.message, { error: true }); }
  }

  async function toggle(bot, active) {
    try { const u = await patch(`/api/bots/${bot.id}`, { active }); setItems((l) => l.map((b) => (b.id === u.id ? u : b))); } catch (err) { toast(err.message, { error: true }); }
  }
  async function rotate(bot) {
    if (!window.confirm(`¿Generar nuevas credenciales para ${bot.name}? Las anteriores dejan de funcionar al instante.`)) return;
    try { const r = await post(`/api/bots/${bot.id}/rotate-key`); setCreds({ name: bot.name, ...r.credentials }); load(); } catch (err) { toast(err.message, { error: true }); }
  }
  async function remove(bot) {
    if (!window.confirm(`¿Eliminar ${bot.name}? Dejará de recibir eventos.`)) return;
    try { await del(`/api/bots/${bot.id}`); load(); } catch (err) { toast(err.message, { error: true }); }
  }

  return (
    <>
      <div className="page-head">
        <p>Tus chatbots ya no reciben webhooks de Meta: el CRM les manda cada mensaje firmado y ellos responden por la API del CRM. Si un agente toma la conversación, el CRM no deja pasar la respuesta del bot.</p>
        <Button id="new-bot" variant="primary" onClick={() => setCreating(true)}><I.plus /> Registrar chatbot</Button>
      </div>

      {items === null ? <Loading /> : items.length === 0 ? (
        <div className="card"><Empty title="Ningún chatbot conectado" icon={<I.bots />}>Registra ValleyTechBot, Samuelito o BlackStation para que respondan a través del CRM.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Nombre</th><th>Endpoint</th><th>Atiende</th><th>IA</th><th>API key</th><th>Último despacho</th><th>Activo</th><th></th></tr></thead>
            <tbody>
              {items.map((b) => (
                <tr key={b.id}>
                  <td>{b.name} <Badge>{b.channel}</Badge></td>
                  <td className="mono small">{b.endpointUrl}</td>
                  <td>
                    <select className="input small" value={b.metaIntegrationId ?? ''} onChange={(e) => assign(b, e.target.value)} title={numberLabel(b.metaIntegrationId)}>
                      <option value="">Todos los números</option>
                      {numbers.map((n) => <option key={n.id} value={n.id}>{n.displayPhoneNumber || n.phoneNumberId} · {n.verifiedName || ''}</option>)}
                    </select>
                  </td>
                  <td><Button size="sm" onClick={() => navigate(`/bots/${b.id}/ai`)} title="Instrucciones, preguntas frecuentes, archivos y sitios web">{b.aiEnabled ? <Badge tone="ok">activa</Badge> : <Badge>apagada</Badge>} Conocimiento</Button></td>
                  <td className="mono small">{b.apiKeyPrefix}…</td>
                  <td className="small">{fmtDateTime(b.lastDispatchAt)}</td>
                  <td><Switch on={b.active} onChange={(v) => toggle(b, v)} /></td>
                  <td><span className="row"><Button size="sm" onClick={() => rotate(b)}>Rotar credenciales</Button><Button size="sm" variant="danger" onClick={() => remove(b)}>Eliminar</Button></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card pad">
        <h3>Cómo se conecta un bot</h3>
        <ol className="small muted" style={{ paddingLeft: 18, marginTop: 8 }}>
          <li>Regístralo aquí con la URL donde recibirá los eventos (por ejemplo <code>https://tu-bot.up.railway.app/crm/events</code>).</li>
          <li>Guarda la API key y el secreto de firma en las variables del bot: <code>CRM_API_KEY</code>, <code>CRM_SIGNING_SECRET</code>, <code>CRM_BASE_URL={config?.publicUrl}</code>.</li>
          <li>Elige en "Atiende" qué número responde ese bot: así ValleyTechBot solo recibe los chats de su número y Samuelito los del suyo.</li>
          <li>Para ValleyTechBot y los bots hechos con la misma plantilla, copia los 4 archivos de <code>examples/valleytechbot/</code>; para otros, <code>examples/bot-adapter.js</code>.</li>
          <li>Guarda el estado conversacional en <code>botState</code>: el CRM lo devuelve en cada evento y no se pierde al desplegar.</li>
        </ol>
      </div>

      {creating ? <BotModal numbers={numbers} onClose={() => setCreating(false)} onDone={(r) => { setCreating(false); setCreds({ name: r.name, ...r.credentials }); load(); }} /> : null}
      {creds ? <CredsModal creds={creds} onClose={() => setCreds(null)} /> : null}
    </>
  );
}

function BotModal({ numbers, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', endpointUrl: '', channel: 'whatsapp', metaIntegrationId: '' });
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true);
    try { onDone(await post('/api/bots', { ...form, metaIntegrationId: form.metaIntegrationId || null })); } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }
  return (
    <Modal title="Registrar chatbot" onClose={onClose}>
      <form className="col" style={{ gap: 12 }} onSubmit={submit}>
        <Field label="Nombre"><input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required minLength={2} /></Field>
        <Field label="URL del endpoint" hint="Debe ser https y responder 200 rápido"><input className="input mono" type="url" value={form.endpointUrl} onChange={(e) => setForm((f) => ({ ...f, endpointUrl: e.target.value }))} required /></Field>
        <Field label="Número que atiende" hint="El bot solo recibirá los mensajes de ese número.">
          <select className="input" value={form.metaIntegrationId} onChange={(e) => setForm((f) => ({ ...f, metaIntegrationId: e.target.value }))}>
            <option value="">Todos los números</option>
            {numbers.map((n) => <option key={n.id} value={n.id}>{n.displayPhoneNumber || n.phoneNumberId} · {n.verifiedName || ''}</option>)}
          </select>
        </Field>
        <div className="row end"><Button variant="primary" type="submit" loading={busy}>Registrar</Button></div>
      </form>
    </Modal>
  );
}

function CredsModal({ creds, onClose }) {
  const toast = useToast();
  const copy = (v) => navigator.clipboard?.writeText(v).then(() => toast('Copiado'));
  return (
    <Modal title={`Credenciales de ${creds.name}`} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Ya las guardé</Button>}>
      <div className="callout warn small">Se muestran una sola vez. Guárdalas ahora en las variables de entorno del bot.</div>
      <Field label="CRM_API_KEY"><div className="row"><input className="input mono" readOnly value={creds.apiKey} /><Button size="sm" onClick={() => copy(creds.apiKey)}>Copiar</Button></div></Field>
      <Field label="CRM_SIGNING_SECRET"><div className="row"><input className="input mono" readOnly value={creds.signingSecret} /><Button size="sm" onClick={() => copy(creds.signingSecret)}>Copiar</Button></div></Field>
    </Modal>
  );
}
