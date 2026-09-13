import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { get, post } from '../api.js';
import { useRouter } from '../router.jsx';
import { useToast } from '../store.jsx';
import { getSocket } from '../socket.js';
import { Badge, Button, Empty, Field, Loading, Modal, Progress, Tabs, fmtDateTime } from '../components/ui.jsx';
import { TemplatePreview, countParams, buildComponents } from '../components/TemplatePicker.jsx';
import { I } from '../components/Icons.jsx';

const TONE = { draft: '', scheduled: 'info', running: 'accent', paused: 'warn', completed: 'ok', cancelled: '', failed: 'crit' };
const LABEL = { draft: 'borrador', scheduled: 'programada', running: 'en curso', paused: 'pausada', completed: 'completada', cancelled: 'cancelada', failed: 'fallida' };

export default function Campaigns({ params }) {
  const { navigate } = useRouter();
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => get('/api/campaigns').then((d) => setItems(d.items)).catch((e) => toast(e.message, { error: true })), [toast]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return undefined;
    const onUpdate = () => load();
    socket.on('campaign:updated', onUpdate);
    return () => socket.off('campaign:updated', onUpdate);
  }, [load]);

  if (params.campaignId) return <CampaignDetail id={params.campaignId} onBack={() => { navigate('/campaigns'); load(); }} />;

  return (
    <>
      <div className="page-head">
        <p>Una campaña envía una plantilla aprobada a un segmento de contactos. Meta cobra cada plantilla según su categoría; el ritmo lo controla la cola de salida.</p>
        <Button id="new-campaign" variant="primary" onClick={() => setCreating(true)}><I.plus /> Nueva campaña</Button>
      </div>
      {items === null ? <Loading /> : items.length === 0 ? (
        <div className="card"><Empty title="Sin campañas" icon={<I.campaigns />}>Crea la primera: elige plantilla, segmento y listo.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Campaña</th><th>Plantilla</th><th>Estado</th><th>Progreso</th><th>Creada</th></tr></thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} className="click" onClick={() => navigate(`/campaigns/${c.id}`)}>
                  <td>{c.name}<div className="tiny faint">{c.totalRecipients} destinatarios</div></td>
                  <td className="mono small">{c.templateName}</td>
                  <td><Badge tone={TONE[c.status]}>{LABEL[c.status]}</Badge></td>
                  <td style={{ minWidth: 160 }}>
                    <Progress total={c.totalRecipients} parts={[
                      { key: 'read', value: c.readCount, color: 'var(--ok)', label: 'leídos' },
                      { key: 'delivered', value: c.deliveredCount - c.readCount, color: 'var(--accent)', label: 'entregados' },
                      { key: 'sent', value: c.sentCount - c.deliveredCount, color: 'var(--info)', label: 'enviados' },
                      { key: 'failed', value: c.failedCount, color: 'var(--crit)', label: 'fallidos' },
                    ]} />
                    <div className="tiny faint tabular">{c.sentCount}/{c.totalRecipients} enviados · {c.failedCount} fallidos</div>
                  </td>
                  <td className="small">{fmtDateTime(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating ? <NewCampaign onClose={() => setCreating(false)} onDone={(c) => { setCreating(false); navigate(`/campaigns/${c.id}`); }} /> : null}
    </>
  );
}

/* ========================================================================== */
function CampaignDetail({ id, onBack }) {
  const toast = useToast();
  const [c, setC] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [status, setStatus] = useState('');

  const load = useCallback(() => {
    Promise.all([get(`/api/campaigns/${id}`), get(`/api/campaigns/${id}/recipients${status ? `?status=${status}` : ''}`)])
      .then(([camp, rec]) => { setC(camp); setRecipients(rec.items); })
      .catch((e) => toast(e.message, { error: true }));
  }, [id, status, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!c || !['running', 'scheduled'].includes(c.status)) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [c, load]);

  async function action(kind) {
    try { setC(await post(`/api/campaigns/${id}/${kind}`)); load(); } catch (err) { toast(err.message, { error: true }); }
  }

  if (!c) return <Loading />;

  return (
    <>
      <div className="page-head">
        <div className="row"><Button variant="ghost" onClick={onBack}><I.back /> Campañas</Button><h2>{c.name}</h2><Badge tone={TONE[c.status]}>{LABEL[c.status]}</Badge></div>
        <div className="row">
          {['draft', 'scheduled', 'paused'].includes(c.status) ? <Button variant="primary" onClick={() => action('start')}><I.play /> {c.status === 'paused' ? 'Reanudar' : 'Iniciar ahora'}</Button> : null}
          {c.status === 'running' ? <Button onClick={() => action('pause')}><I.pause /> Pausar</Button> : null}
          {!['completed', 'cancelled'].includes(c.status) ? <Button variant="danger" onClick={() => window.confirm('¿Cancelar la campaña? Los pendientes no se enviarán.') && action('cancel')}>Cancelar</Button> : null}
        </div>
      </div>

      <div className="grid cols-4">
        {[['Destinatarios', c.totalRecipients], ['Enviados', c.sentCount], ['Entregados', c.deliveredCount], ['Leídos', c.readCount], ['Fallidos', c.failedCount]].map(([k, v]) => (
          <div key={k} className="kpi"><span className="v">{v}</span><span className="k">{k}</span></div>
        ))}
      </div>

      <div className="card pad small muted">
        Plantilla <code>{c.templateName}</code> ({c.templateLanguage}) · {c.scheduledAt ? `programada para ${fmtDateTime(c.scheduledAt)}` : 'sin programar'} · {c.startedAt ? `iniciada ${fmtDateTime(c.startedAt)}` : ''} {c.completedAt ? `· terminada ${fmtDateTime(c.completedAt)}` : ''}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Destinatarios</h3>
          <select className="select" style={{ width: 180 }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos</option>
            {['pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'skipped'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Contacto</th><th>Número</th><th>Estado</th><th>Enviado</th><th>Error</th></tr></thead>
            <tbody>
              {recipients.map((r) => (
                <tr key={r.id}>
                  <td>{r.contact?.name || '—'}</td>
                  <td className="mono">{r.waId}</td>
                  <td><Badge tone={{ read: 'ok', delivered: 'accent', sent: 'info', failed: 'crit', queued: 'warn' }[r.status] ?? ''}>{r.status}</Badge></td>
                  <td className="small">{fmtDateTime(r.sentAt)}</td>
                  <td className="small" style={{ color: 'var(--crit)' }}>{r.errorMessage ?? ''}</td>
                </tr>
              ))}
              {recipients.length === 0 ? <tr><td colSpan={5} className="muted">Nadie en este estado</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ========================================================================== */
function NewCampaign({ onClose, onDone }) {
  const toast = useToast();
  const [templates, setTemplates] = useState([]);
  const [numbers, setNumbers] = useState([]);
  const [tags, setTags] = useState([]);
  const [form, setForm] = useState({ name: '', integrationId: '', templateId: '', segment: 'all', tagList: '', scheduledAt: '' });
  const [values, setValues] = useState({ header: [], body: [], buttons: {} });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get('/api/templates?status=approved').then((d) => setTemplates(d.items)).catch(() => {});
    get('/api/integrations').then((d) => setNumbers(d.items.filter((n) => n.active))).catch(() => {});
    get('/api/contacts?limit=200').then((d) => setTags(Array.from(new Set(d.items.flatMap((c) => c.tags ?? []))).sort())).catch(() => {});
  }, []);

  const template = templates.find((t) => t.id === form.templateId) ?? null;
  const bodyN = countParams(template?.components?.find((c) => c.type === 'BODY')?.text);
  useEffect(() => {
    setValues({ header: [], body: Array(bodyN).fill('').map((_, i) => (i === 0 ? '{{contact.name}}' : '')), buttons: {} });
  }, [form.templateId, bodyN]);

  const recipients = useMemo(() => {
    if (form.segment === 'tags') return { tags: form.tagList.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) };
    return { all: true };
  }, [form.segment, form.tagList]);

  useEffect(() => {
    setPreview(null);
    post('/api/campaigns/preview', { recipients }).then(setPreview).catch(() => setPreview({ count: 0 }));
  }, [recipients]);

  async function submit(e) {
    e.preventDefault();
    if (!template) return toast('Elige una plantilla', { error: true });
    setBusy(true);
    try {
      const created = await post('/api/campaigns', {
        name: form.name,
        integrationId: form.integrationId || undefined,
        templateName: template.name,
        templateLanguage: template.language,
        components: buildComponents(template, values),
        recipients,
        scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : undefined,
      });
      toast(`Campaña creada con ${created.totalRecipients} destinatarios`);
      onDone(created);
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const sampleContact = { name: preview?.sample?.[0]?.name ?? 'Ana' };
  const previewValues = { body: values.body.map((v) => v.replace(/\{\{\s*contact\.name\s*\}\}/g, sampleContact.name)) };

  return (
    <Modal title="Nueva campaña" onClose={onClose} wide footer={<Button variant="primary" onClick={submit} loading={busy} disabled={!form.name || !template || !preview?.count}>Crear campaña</Button>}>
      <div className="grid cols-2">
        <div className="col" style={{ gap: 12 }}>
          <Field label="Nombre interno"><input className="input" value={form.name} onChange={set('name')} placeholder="Promo septiembre" /></Field>
          <Field label="Número que envía" hint="Si no eliges, se usa el primero activo">
            <select className="select" value={form.integrationId} onChange={set('integrationId')}>
              <option value="">Automático</option>
              {numbers.map((n) => <option key={n.id} value={n.id}>{n.displayPhoneNumber} · {n.verifiedName ?? ''}</option>)}
            </select>
          </Field>
          <Field label="Plantilla aprobada">
            <select className="select" value={form.templateId} onChange={set('templateId')}>
              <option value="">Elige…</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.language} · {t.category}</option>)}
            </select>
          </Field>
          {values.body.map((v, i) => (
            <Field key={i} label={`Parámetro {{${i + 1}}}`} hint="Puedes usar {{contact.name}} o {{contact.customFields.campo}}">
              <input className="input" value={v} onChange={(e) => setValues((s) => ({ ...s, body: s.body.map((x, j) => (j === i ? e.target.value : x)) }))} />
            </Field>
          ))}
          <Field label="Segmento">
            <Tabs value={form.segment} onChange={(v) => setForm((f) => ({ ...f, segment: v }))} items={[{ value: 'all', label: 'Todos los contactos' }, { value: 'tags', label: 'Por etiqueta' }]} />
          </Field>
          {form.segment === 'tags' ? (
            <Field label="Etiquetas" hint={tags.length ? `Disponibles: ${tags.join(', ')}` : 'Separadas por coma'}>
              <input className="input" value={form.tagList} onChange={set('tagList')} placeholder="cliente, vip" />
            </Field>
          ) : null}
          <Field label="Programar (opcional)"><input className="input" type="datetime-local" value={form.scheduledAt} onChange={set('scheduledAt')} /></Field>
        </div>
        <div className="col" style={{ gap: 12 }}>
          <div className="kpi"><span className="v">{preview ? preview.count : '…'}</span><span className="k">contactos recibirán la plantilla</span>{preview?.sample?.length ? <span className="d">p. ej. {preview.sample.map((s) => s.name || s.waId).join(', ')}</span> : null}</div>
          {template ? <><span className="label">Vista previa</span><TemplatePreview template={template} values={previewValues} /></> : <Empty title="Elige una plantilla para ver la vista previa" />}
          <div className="callout warn small">Las plantillas de marketing tienen costo por mensaje y los clientes pueden bloquear al número si reciben demasiadas. Empieza con segmentos pequeños.</div>
        </div>
      </div>
    </Modal>
  );
}
