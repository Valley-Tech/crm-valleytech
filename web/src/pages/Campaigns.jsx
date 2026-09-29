import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { get, post } from '../api.js';
import { useRouter } from '../router.jsx';
import { useToast } from '../store.jsx';
import { getSocket } from '../socket.js';
import { Badge, Button, Empty, Field, Loading, Modal, Progress, Tabs, fmtDateTime, numberLabel } from '../components/ui.jsx';
import { TemplatePreview, TemplateParamsFields, buildComponents, emptyValues, valuesComplete } from '../components/TemplatePicker.jsx';
import { I } from '../components/Icons.jsx';

const TONE = { draft: '', scheduled: 'info', running: 'accent', paused: 'warn', completed: 'ok', cancelled: '', failed: 'crit' };
const LABEL = { draft: 'borrador', scheduled: 'programada', running: 'en curso', paused: 'pausada', completed: 'completada', cancelled: 'cancelada', failed: 'fallida' };

export default function Campaigns({ params }) {
  const { navigate } = useRouter();
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [creating, setCreating] = useState(false);
  const [numbers, setNumbers] = useState([]);
  const [numberId, setNumberId] = useState('');

  useEffect(() => {
    get('/api/inbox/channels').then((d) => setNumbers(d.items.filter((n) => n.active))).catch(() => {});
  }, []);

  const load = useCallback(() => get(`/api/campaigns${numberId ? `?integrationId=${numberId}` : ''}`).then((d) => setItems(d.items)).catch((e) => toast(e.message, { error: true })), [toast, numberId]);
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
        <p>Una campaña envía una plantilla aprobada de tu chatbot a un segmento de sus contactos. Meta cobra cada plantilla según su categoría; el ritmo lo controla la cola de salida.</p>
        <div className="row wrap">
          {numbers.length > 1 ? (
            <select id="campaigns-number" className="select" value={numberId} onChange={(e) => setNumberId(e.target.value)} style={{ maxWidth: 320 }}>
              <option value="">Todos mis chatbots</option>
              {numbers.map((n) => <option key={n.id} value={n.id}>{numberLabel(n)}</option>)}
            </select>
          ) : null}
          <Button id="new-campaign" variant="primary" onClick={() => setCreating(true)} disabled={numbers.length === 0}><I.plus /> Nueva campaña</Button>
        </div>
      </div>
      {items === null ? <Loading /> : items.length === 0 ? (
        <div className="card"><Empty title="Sin campañas" icon={<I.campaigns />}>Crea la primera: elige plantilla, segmento y listo.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Campaña</th><th>Chatbot</th><th>Plantilla</th><th>Estado</th><th>Progreso</th><th>Creada</th></tr></thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} className="click" onClick={() => navigate(`/campaigns/${c.id}`)}>
                  <td>{c.name}<div className="tiny faint">{c.totalRecipients} destinatarios</div></td>
                  <td className="small">{c.integration ? numberLabel(c.integration) : <span className="faint">—</span>}</td>
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
      {creating ? <NewCampaign numbers={numbers} initialNumberId={numberId || (numbers.length === 1 ? numbers[0].id : '')} onClose={() => setCreating(false)} onDone={(c) => { setCreating(false); navigate(`/campaigns/${c.id}`); }} /> : null}
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
        {c.integration ? <>Chatbot <strong>{numberLabel(c.integration)}</strong> · </> : null}Plantilla <code>{c.templateName}</code> ({c.templateLanguage}) · {c.scheduledAt ? `programada para ${fmtDateTime(c.scheduledAt)}` : 'sin programar'} · {c.startedAt ? `iniciada ${fmtDateTime(c.startedAt)}` : ''} {c.completedAt ? `· terminada ${fmtDateTime(c.completedAt)}` : ''}
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
function NewCampaign({ numbers, initialNumberId = '', onClose, onDone }) {
  const toast = useToast();
  const [templates, setTemplates] = useState([]);
  const [tags, setTags] = useState([]);
  const [form, setForm] = useState({ name: '', integrationId: initialNumberId, templateId: '', segment: 'all', tagList: '', scheduledAt: '' });
  const [values, setValues] = useState(emptyValues(null));
  const [preview, setPreview] = useState(null);
  const [check, setCheck] = useState(null); // { ok, problems, recipients }
  const [busy, setBusy] = useState(false);

  // Las plantillas y las etiquetas dependen del número elegido: cada chatbot tiene las suyas.
  useEffect(() => {
    setTemplates([]);
    setForm((f) => ({ ...f, templateId: '' }));
    if (!form.integrationId) return;
    get(`/api/templates?status=approved&integrationId=${form.integrationId}`).then((d) => setTemplates(d.items)).catch(() => {});
    get(`/api/contacts?limit=200&integrationId=${form.integrationId}`).then((d) => setTags(Array.from(new Set(d.items.flatMap((c) => c.tags ?? []))).sort())).catch(() => {});
  }, [form.integrationId]);

  const template = templates.find((t) => t.id === form.templateId) ?? null;
  useEffect(() => {
    setValues(emptyValues(template, { firstBody: '{{contact.name|Cliente}}' }));
  }, [form.templateId]); // eslint-disable-line react-hooks/exhaustive-deps

  const recipients = useMemo(() => {
    if (form.segment === 'tags') return { tags: form.tagList.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) };
    return { all: true };
  }, [form.segment, form.tagList]);

  useEffect(() => {
    setPreview(null);
    post('/api/campaigns/preview', { recipients, integrationId: form.integrationId || undefined }).then(setPreview).catch(() => setPreview({ count: 0 }));
  }, [recipients, form.integrationId]);

  const components = useMemo(() => (template ? buildComponents(template, values) : []), [template, values]);
  const localComplete = template ? valuesComplete(template, values) : false;

  // Validación en el servidor (plantilla, parámetros, contactos sin nombre…) con un pequeño retraso al escribir.
  useEffect(() => {
    if (!template || !form.integrationId) { setCheck(null); return undefined; }
    const timer = setTimeout(() => {
      post('/api/campaigns/validate', { integrationId: form.integrationId, templateName: template.name, templateLanguage: template.language, components, recipients })
        .then(setCheck)
        .catch((err) => setCheck({ ok: false, problems: [err.message] }));
    }, 400);
    return () => clearTimeout(timer);
  }, [template, form.integrationId, components, recipients]);

  async function submit(e) {
    e.preventDefault();
    if (!form.integrationId) return toast('Elige el chatbot (número) que envía', { error: true });
    if (!template) return toast('Elige una plantilla', { error: true });
    setBusy(true);
    try {
      const created = await post('/api/campaigns', {
        name: form.name,
        integrationId: form.integrationId,
        templateName: template.name,
        templateLanguage: template.language,
        components,
        recipients,
        scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : undefined,
      });
      toast(`Campaña creada con ${created.totalRecipients} destinatarios`);
      onDone(created);
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const sampleContact = { name: preview?.sample?.[0]?.name ?? 'Ana' };
  const fillSample = (v) => (typeof v === 'string' ? v.replace(/\{\{\s*contact\.name(?:\|([^}]*))?\s*\}\}/g, (_, d) => sampleContact.name || d || '') : v);
  const previewValues = { ...values, body: values.body.map(fillSample), header: values.header.map(fillSample) };
  const canCreate = Boolean(form.name && form.integrationId && template && preview?.count && localComplete && check?.ok);

  return (
    <Modal title="Nueva campaña" onClose={onClose} wide footer={<Button id="create-campaign" variant="primary" onClick={submit} loading={busy} disabled={!canCreate}>Crear campaña</Button>}>
      <div className="grid cols-2">
        <div className="col" style={{ gap: 12 }}>
          <Field label="Nombre interno"><input className="input" value={form.name} onChange={set('name')} placeholder="Promo septiembre" /></Field>
          <Field label="Chatbot que envía" hint="Las plantillas y los contactos son los de ese número">
            <select id="campaign-number" className="select" value={form.integrationId} onChange={set('integrationId')} disabled={numbers.length === 1}>
              <option value="">Elige…</option>
              {numbers.map((n) => <option key={n.id} value={n.id}>{numberLabel(n)}</option>)}
            </select>
          </Field>
          <Field label="Plantilla aprobada" hint={form.integrationId && templates.length === 0 ? 'Este número no tiene plantillas aprobadas sincronizadas' : undefined}>
            <select id="campaign-template" className="select" value={form.templateId} onChange={set('templateId')} disabled={!form.integrationId}>
              <option value="">Elige…</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.language} · {t.category}</option>)}
            </select>
          </Field>
          {template ? <TemplateParamsFields template={template} values={values} onChange={setValues} campaign /> : null}
          <Field label="Segmento">
            <Tabs value={form.segment} onChange={(v) => setForm((f) => ({ ...f, segment: v }))} items={[{ value: 'all', label: 'Todos mis contactos' }, { value: 'tags', label: 'Por etiqueta' }]} />
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
          {template && check ? (
            check.ok ? (
              <div className="callout small" id="campaign-check-ok">✔ Plantilla y parámetros verificados con Meta: la campaña se puede crear.</div>
            ) : (
              <div className="callout warn small" id="campaign-check-problems">
                <strong>Antes de crear la campaña:</strong>
                <ul style={{ margin: '4px 0 0 18px' }}>{check.problems.map((p) => <li key={p}>{p}</li>)}</ul>
              </div>
            )
          ) : null}
          <div className="callout warn small">Las plantillas de marketing tienen costo por mensaje y los clientes pueden bloquear al número si reciben demasiadas. Empieza con segmentos pequeños.</div>
        </div>
      </div>
    </Modal>
  );
}
