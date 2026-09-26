import React, { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, patch, del, api } from '../api.js';
import { useRouter } from '../router.jsx';
import { useToast } from '../store.jsx';
import { Badge, Button, Empty, Field, Loading, Modal, Switch, Confirm, fmtDateTime } from '../components/ui.jsx';
import { I } from '../components/Icons.jsx';

/**
 * IA y conocimiento de un chatbot (como "Administrar Meta Business Agent"):
 * instrucciones, preguntas frecuentes, archivos, sitios web, textos y una
 * consola para probar las respuestas sin enviar nada por WhatsApp.
 */

const STATUS = {
  pending: { label: 'en cola', tone: '' },
  processing: { label: 'indexando…', tone: 'info' },
  ready: { label: 'listo', tone: 'ok' },
  error: { label: 'error', tone: 'crit' },
};
const KIND = { file: 'Archivo', url: 'Página', site: 'Sitio web', faq: 'Pregunta frecuente', text: 'Texto' };
const ACCEPT = '.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.html,.htm,.xml,.rtf,.jpg,.jpeg,.png,.webp,.gif';

const fmtBytes = (n) => (!n ? '' : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export default function BotAI({ params }) {
  const { navigate } = useRouter();
  const toast = useToast();
  const botId = params.botId;
  const [bot, setBot] = useState(null);
  const [ai, setAi] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [bots, data] = await Promise.all([get('/api/bots'), get(`/api/bots/${botId}/ai`)]);
      const found = bots.items.find((b) => b.id === botId);
      if (!found) { toast('Chatbot no encontrado', { error: true }); navigate('/bots'); return; }
      setBot(found);
      setAi(data);
      setForm((f) => f ?? { aiEnabled: data.aiEnabled, aiModel: data.aiModel ?? '', aiInstructions: data.aiInstructions, aiTemperature: data.aiTemperature, aiMaxChars: data.aiMaxChars });
    } catch (err) { toast(err.message, { error: true }); }
  }, [botId, toast, navigate]);
  useEffect(() => { load(); }, [load]);

  // Mientras haya fuentes en cola o indexando, se refresca solo.
  useEffect(() => {
    if (!ai?.sources?.some((s) => s.status === 'pending' || s.status === 'processing')) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [ai, load]);

  async function saveSettings(partial) {
    setSaving(true);
    try {
      const data = partial ?? { aiEnabled: form.aiEnabled, aiModel: form.aiModel || null, aiInstructions: form.aiInstructions, aiTemperature: Number(form.aiTemperature), aiMaxChars: Number(form.aiMaxChars) };
      const updated = await patch(`/api/bots/${botId}/ai`, data);
      setAi((a) => ({ ...a, ...updated }));
      setForm((f) => ({ ...f, ...(partial ?? {}) }));
      toast('Guardado');
    } catch (err) { toast(err.message, { error: true }); } finally { setSaving(false); }
  }

  async function runConfirm() {
    if (!confirm) return;
    setBusy(true);
    try {
      await del(`/api/bots/${botId}/knowledge/${confirm.id}`);
      toast('Fuente eliminada');
      setConfirm(null);
      load();
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }

  if (!bot || !ai || !form) return <Loading />;

  const sources = ai.sources ?? [];
  const byKind = (k) => sources.filter((s) => (Array.isArray(k) ? k.includes(s.kind) : s.kind === k));
  const ready = sources.filter((s) => s.status === 'ready').length;
  const done = { instructions: Boolean(form.aiInstructions?.trim()), faq: byKind('faq').some((s) => s.status === 'ready'), files: byKind('file').some((s) => s.status === 'ready'), web: byKind(['site', 'url']).some((s) => s.status === 'ready') };
  const completed = Object.values(done).filter(Boolean).length;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row" style={{ gap: 10 }}>
            <button className="btn ghost icon" onClick={() => navigate('/bots')} aria-label="Volver"><I.back /></button>
            <h2 style={{ margin: 0 }}>{bot.name} · IA y conocimiento</h2>
          </div>
          <p>Enseña a la IA de este chatbot con tus propios documentos, tu sitio web y tus preguntas frecuentes. Responde con Gemini usando solo esa información.</p>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="small muted">{ai.aiEnabled ? 'IA activa' : 'IA desactivada'}</span>
          <Switch on={form.aiEnabled} onChange={(v) => saveSettings({ aiEnabled: v })} disabled={!ai.geminiConfigured} />
        </div>
      </div>

      {!ai.geminiConfigured ? (
        <div className="callout crit small">El servidor no tiene <code>GEMINI_API_KEY</code>. Crea una clave en Google AI Studio y ponla en las variables del CRM (web y worker) para activar la IA.</div>
      ) : null}

      <div className="card pad">
        <div className="row between wrap">
          <div>
            <strong>{completed} de 4 pasos completados</strong>
            <div className="small muted">{ready} fuente{ready === 1 ? '' : 's'} lista{ready === 1 ? '' : 's'} · Modelo: <span className="mono">{form.aiModel || ai.defaultModel}</span></div>
          </div>
          <div className="progress-bar" aria-hidden="true"><span style={{ width: `${(completed / 4) * 100}%` }} /></div>
        </div>
      </div>

      {/* ---------------------------------------------------------- Instrucciones */}
      <Section done={done.instructions} title="Información del negocio e instrucciones" hint="Cuéntale a la IA quién es, qué vende el negocio, horario, tono y qué NO debe hacer.">
        <textarea className="textarea" rows={9} value={form.aiInstructions} onChange={(e) => setForm((f) => ({ ...f, aiInstructions: e.target.value }))} placeholder={`Eres Misha, la asesora virtual de Mishabella, tienda de moda en Colombia. Ayudas a elegir tallas y colores, explicas envíos y pagos y guías al cliente a comprar desde el catálogo de WhatsApp…`} />
        <div className="row wrap" style={{ gap: 12 }}>
          <Field label="Modelo" hint="Vacío = el del servidor">
            <select className="select" value={form.aiModel} onChange={(e) => setForm((f) => ({ ...f, aiModel: e.target.value }))}>
              <option value="">Por defecto ({ai.defaultModel})</option>
              {ai.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Creatividad" hint="0 = literal · 1 = creativa">
            <input className="input" type="number" min={0} max={1} step={0.1} value={form.aiTemperature} onChange={(e) => setForm((f) => ({ ...f, aiTemperature: e.target.value }))} style={{ width: 110 }} />
          </Field>
          <Field label="Largo máximo" hint="caracteres por respuesta">
            <input className="input" type="number" min={120} max={3000} step={20} value={form.aiMaxChars} onChange={(e) => setForm((f) => ({ ...f, aiMaxChars: e.target.value }))} style={{ width: 120 }} />
          </Field>
        </div>
        <div className="row end"><Button variant="primary" loading={saving} onClick={() => saveSettings()}>Guardar instrucciones</Button></div>
      </Section>

      {/* ---------------------------------------------------------- FAQ */}
      <Section done={done.faq} title="Preguntas frecuentes" hint="Respuestas exactas que la IA debe dar siempre igual (envíos, cambios, pagos, horarios).">
        <FaqForm botId={botId} onAdded={load} />
        <SourceList items={byKind('faq')} onDelete={setConfirm} onReindex={(s) => post(`/api/bots/${botId}/knowledge/${s.id}/reindex`).then(load)} empty="Sin preguntas frecuentes todavía." />
      </Section>

      {/* ---------------------------------------------------------- Archivos */}
      <Section done={done.files} title="Archivos" hint="PDF, Word, Excel, PowerPoint, texto, CSV, JSON, HTML, XML e imágenes (JPG/PNG: la IA las lee y transcribe). Hasta 25 MB por archivo.">
        <FileUpload botId={botId} onDone={load} />
        <SourceList items={byKind('file')} onDelete={setConfirm} onReindex={(s) => post(`/api/bots/${botId}/knowledge/${s.id}/reindex`).then(load)} empty="Sin archivos todavía." />
      </Section>

      {/* ---------------------------------------------------------- Sitios web */}
      <Section done={done.web} title="Sitios web" hint="La IA rastrea las páginas del sitio (hasta el límite que elijas). Si es una tienda Shopify, también lee el catálogo completo con precios, colores y tallas.">
        <UrlForm botId={botId} onAdded={load} />
        <SourceList items={byKind(['site', 'url'])} onDelete={setConfirm} onReindex={(s) => post(`/api/bots/${botId}/knowledge/${s.id}/reindex`).then(load)} empty="Sin sitios web todavía." />
      </Section>

      {/* ---------------------------------------------------------- Textos */}
      <Section done={byKind('text').some((s) => s.status === 'ready')} title="Textos" hint="Políticas, descripciones, listas de precios… cualquier texto que quieras que la IA conozca." optional>
        <TextForm botId={botId} onAdded={load} />
        <SourceList items={byKind('text')} onDelete={setConfirm} onReindex={(s) => post(`/api/bots/${botId}/knowledge/${s.id}/reindex`).then(load)} empty="Sin textos todavía." />
      </Section>

      {/* ---------------------------------------------------------- Probar */}
      <Section done={false} title="Probar la IA" hint="Conversa aquí como si fueras un cliente. No se envía nada por WhatsApp." optional>
        <Playground botId={botId} disabled={!ai.geminiConfigured} />
      </Section>

      {confirm ? (
        <Confirm title={`¿Eliminar "${confirm.name}"?`} confirmLabel="Eliminar" danger busy={busy} onConfirm={runConfirm} onClose={() => setConfirm(null)}>
          La IA dejará de usar esta fuente de inmediato. Se borra del CRM y del almacén de Gemini.
        </Confirm>
      ) : null}
    </>
  );
}

/* ========================================================================== */
function Section({ title, hint, done, optional = false, children }) {
  return (
    <div className="card pad kb-section">
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <span className={`kb-check ${done ? 'on' : ''}`} aria-hidden="true">{done ? <I.check /> : null}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>{title} {optional ? <Badge>opcional</Badge> : null}</h3>
          <p className="small muted" style={{ margin: '4px 0 12px' }}>{hint}</p>
          <div className="col" style={{ gap: 12 }}>{children}</div>
        </div>
      </div>
    </div>
  );
}

function SourceList({ items, onDelete, onReindex, empty }) {
  if (!items.length) return <span className="small faint">{empty}</span>;
  return (
    <div className="kb-list">
      {items.map((s) => {
        const st = STATUS[s.status] ?? STATUS.pending;
        return (
          <div key={s.id} className="kb-item">
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="truncate" style={{ fontWeight: 600 }}>{s.name}</span>
                <Badge tone={st.tone}>{st.label}</Badge>
              </div>
              <div className="tiny faint truncate">
                {KIND[s.kind]}
                {s.sizeBytes ? ` · ${fmtBytes(s.sizeBytes)}` : ''}
                {s.kind === 'site' && s.status === 'ready' ? ` · ${s.pages} página${s.pages === 1 ? '' : 's'}${s.catalog ? ' + catálogo Shopify' : ''}` : ''}
                {s.sourceUrl ? ` · ${s.sourceUrl}` : ''}
                {s.indexedAt ? ` · ${fmtDateTime(s.indexedAt)}` : ''}
              </div>
              {s.kind === 'faq' && s.content ? <div className="small" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{s.content.split('\n---\n')[1]}</div> : null}
              {s.status === 'error' ? <div className="small" style={{ color: 'var(--crit)', marginTop: 4 }}>{s.error}</div> : null}
            </div>
            <span className="row" style={{ gap: 6, flex: 'none' }}>
              {s.status === 'error' || s.status === 'ready' ? <Button size="sm" onClick={() => onReindex(s)} title="Volver a indexar"><I.refresh /></Button> : <span className="spinner" />}
              <Button size="sm" variant="danger" onClick={() => onDelete(s)} title="Eliminar"><I.trash /></Button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FaqForm({ botId, onAdded }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [a, setA] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try { await post(`/api/bots/${botId}/knowledge/faq`, { question: q.trim(), answer: a.trim() }); setQ(''); setA(''); onAdded(); toast('Pregunta agregada'); } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }
  return (
    <form className="col" style={{ gap: 8 }} onSubmit={submit}>
      <input className="input" placeholder="Pregunta (ej. ¿Hacen envíos a todo el país?)" value={q} onChange={(e) => setQ(e.target.value)} required minLength={3} />
      <textarea className="textarea" rows={2} placeholder="Respuesta exacta" value={a} onChange={(e) => setA(e.target.value)} required />
      <div className="row end"><Button type="submit" loading={busy}><I.plus /> Agregar pregunta</Button></div>
    </form>
  );
}

function FileUpload({ botId, onDone }) {
  const toast = useToast();
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  async function send(files) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const form = new FormData();
      for (const f of files) form.append('files', f);
      const r = await api(`/api/bots/${botId}/knowledge/files`, { method: 'POST', body: form, raw: true });
      toast(`${r.items.length} archivo${r.items.length === 1 ? '' : 's'} en cola de indexación`);
      onDone();
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); if (ref.current) ref.current.value = ''; }
  }
  return (
    <div
      className={`kb-drop ${dragging ? 'over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); send(e.dataTransfer.files); }}
    >
      <input ref={ref} type="file" multiple hidden accept={ACCEPT} onChange={(e) => send(e.target.files)} />
      <span className="small">Arrastra archivos aquí o</span>
      <Button size="sm" loading={busy} onClick={() => ref.current?.click()}><I.clip /> Elegir archivos</Button>
    </div>
  );
}

function UrlForm({ botId, onAdded }) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [crawl, setCrawl] = useState(true);
  const [maxPages, setMaxPages] = useState(25);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try { await post(`/api/bots/${botId}/knowledge/url`, { url: url.trim(), crawl, maxPages: Number(maxPages) }); setUrl(''); onAdded(); toast('Sitio en cola de indexación'); } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }
  return (
    <form className="row wrap" style={{ gap: 8, alignItems: 'center' }} onSubmit={submit}>
      <input className="input" type="url" placeholder="https://mishabellastore.com" value={url} onChange={(e) => setUrl(e.target.value)} required style={{ flex: 1, minWidth: 220 }} />
      <label className="checkbox small"><input type="checkbox" checked={crawl} onChange={(e) => setCrawl(e.target.checked)} /> Rastrear todo el sitio</label>
      {crawl ? <label className="small row" style={{ gap: 6 }}>hasta <input className="input" type="number" min={1} max={100} value={maxPages} onChange={(e) => setMaxPages(e.target.value)} style={{ width: 70 }} /> páginas</label> : null}
      <Button type="submit" loading={busy}><I.plus /> Agregar</Button>
    </form>
  );
}

function TextForm({ botId, onAdded }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try { await post(`/api/bots/${botId}/knowledge/text`, { name: name.trim(), content: content.trim() }); setName(''); setContent(''); onAdded(); toast('Texto agregado'); } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }
  return (
    <form className="col" style={{ gap: 8 }} onSubmit={submit}>
      <input className="input" placeholder="Título (ej. Política de cambios)" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
      <textarea className="textarea" rows={4} placeholder="Texto" value={content} onChange={(e) => setContent(e.target.value)} required minLength={10} />
      <div className="row end"><Button type="submit" loading={busy}><I.plus /> Agregar texto</Button></div>
    </form>
  );
}

function Playground({ botId, disabled }) {
  const toast = useToast();
  const [msgs, setMsgs] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; }, [msgs]);

  async function send(e) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    const history = msgs.map((m) => ({ role: m.role, text: m.text }));
    setMsgs((m) => [...m, { role: 'user', text }]);
    setDraft('');
    setBusy(true);
    try {
      const r = await post(`/api/bots/${botId}/ai/test`, { message: text, history });
      setMsgs((m) => [...m, { role: 'model', text: r.text, meta: `${r.model} · ${r.ms} ms${r.usedKnowledge ? ' · con conocimiento' : ''}${r.sources?.length ? ` · fuentes: ${r.sources.length}` : ''}` }]);
    } catch (err) {
      toast(err.message, { error: true });
      setMsgs((m) => [...m, { role: 'model', text: `⚠️ ${err.message}`, error: true }]);
    } finally { setBusy(false); }
  }

  return (
    <div className="kb-play">
      <div className="kb-play-box" ref={boxRef}>
        {msgs.length === 0 ? <span className="small faint">Escribe algo como "¿Tienen tenis talla 38?" o "¿Cuánto vale el envío?"</span> : null}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role === 'user' ? 'outbound' : 'inbound'}`} style={{ maxWidth: '85%' }}>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
            {m.meta ? <div className="meta"><span>{m.meta}</span></div> : null}
          </div>
        ))}
        {busy ? <div className="msg inbound"><span className="spinner" /></div> : null}
      </div>
      <form className="row" style={{ gap: 8 }} onSubmit={send}>
        <input className="input" placeholder="Escribe como un cliente…" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={disabled} style={{ flex: 1 }} />
        <Button type="submit" variant="primary" loading={busy} disabled={disabled || !draft.trim()}><I.send /></Button>
        {msgs.length ? <Button type="button" onClick={() => setMsgs([])}>Limpiar</Button> : null}
      </form>
    </div>
  );
}
