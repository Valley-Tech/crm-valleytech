import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, post } from '../api.js';
import { useToast } from '../store.jsx';
import { Badge, Button, Field, Modal, Tabs, numberLabel } from './ui.jsx';
import { TemplatePreview, countParams } from './TemplatePicker.jsx';
import { I } from './Icons.jsx';

/**
 * "Crear plantilla" dentro del CRM, con los mismos pasos que el WhatsApp
 * Manager: categoría → contenido (cabecera, cuerpo, pie, botones) → revisar y
 * enviar. La plantilla se crea en la WABA del chatbot elegido y queda
 * "pendiente" hasta que Meta la apruebe (normalmente minutos; a veces horas).
 */

export const LANGUAGES = [
  { value: 'es_CO', label: 'Español (Colombia)' },
  { value: 'es', label: 'Español' },
  { value: 'es_MX', label: 'Español (México)' },
  { value: 'es_AR', label: 'Español (Argentina)' },
  { value: 'es_ES', label: 'Español (España)' },
  { value: 'en_US', label: 'Inglés (EE. UU.)' },
  { value: 'en', label: 'Inglés' },
  { value: 'pt_BR', label: 'Portugués (Brasil)' },
];

const CATEGORIES = [
  { value: 'MARKETING', label: 'Marketing', help: 'Promociones, novedades, recordatorios comerciales. Es la categoría más cara por mensaje.' },
  { value: 'UTILITY', label: 'Utilidad', help: 'Confirmaciones, pedidos, citas, actualizaciones de cuenta: mensajes que el cliente espera.' },
];

const HEADERS = [
  { value: 'none', label: 'Sin cabecera' },
  { value: 'text', label: 'Texto' },
  { value: 'image', label: 'Imagen' },
  { value: 'video', label: 'Video' },
  { value: 'document', label: 'Documento (PDF)' },
];

const ACCEPT = { image: 'image/jpeg,image/png', video: 'video/mp4', document: 'application/pdf' };

const slug = (s) => s.toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');

/** Estado del borrador → cuerpo que espera POST /api/templates. */
function toDraft(form) {
  return {
    integrationId: form.integrationId,
    name: slug(form.name),
    language: form.language,
    category: form.category,
    allowCategoryChange: true,
    header: form.header.type === 'none' ? { type: 'none' } : form.header.type === 'text'
      ? { type: 'text', text: form.header.text, example: form.header.example }
      : { type: form.header.type, handle: form.header.handle },
    body: { text: form.body, examples: form.examples },
    footer: form.footer || undefined,
    buttons: form.buttons.map((b) => (b.type === 'copy_code' ? { type: b.type, example: b.example } : b.type === 'url' ? { type: 'url', text: b.text, url: b.url, example: b.example || undefined } : b.type === 'phone' ? { type: 'phone', text: b.text, phone: b.phone } : { type: 'quick_reply', text: b.text })),
  };
}

/** Componentes al estilo Meta para la vista previa, a partir del borrador. */
function previewComponents(form) {
  const comps = [];
  if (form.header.type === 'text' && form.header.text) comps.push({ type: 'HEADER', format: 'TEXT', text: form.header.text });
  else if (form.header.type !== 'none') comps.push({ type: 'HEADER', format: form.header.type.toUpperCase() });
  comps.push({ type: 'BODY', text: form.body || 'Escribe el mensaje…' });
  if (form.footer) comps.push({ type: 'FOOTER', text: form.footer });
  if (form.buttons.length) {
    const ordered = [...form.buttons.filter((b) => b.type !== 'quick_reply'), ...form.buttons.filter((b) => b.type === 'quick_reply')];
    comps.push({ type: 'BUTTONS', buttons: ordered.map((b) => ({ type: b.type.toUpperCase(), text: b.type === 'copy_code' ? (b.text || 'Copiar código') : b.text || '…' })) });
  }
  return comps;
}

export function TemplateBuilder({ numbers, initialNumberId = '', onClose, onDone }) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    integrationId: initialNumberId || (numbers.length === 1 ? numbers[0].id : ''),
    name: '',
    language: 'es_CO',
    category: 'MARKETING',
    header: { type: 'none', text: '', example: '', handle: '', fileName: '' },
    body: '',
    examples: [],
    footer: '',
    buttons: [],
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setHeader = (patch) => setForm((f) => ({ ...f, header: { ...f.header, ...patch } }));

  const bodyVars = countParams(form.body);
  useEffect(() => {
    setForm((f) => ({ ...f, examples: Array.from({ length: bodyVars }, (_, i) => f.examples[i] ?? '') }));
  }, [bodyVars]);

  const number = numbers.find((n) => n.id === form.integrationId) ?? null;
  const previewTemplate = useMemo(() => ({ components: previewComponents(form) }), [form]);
  const previewValues = useMemo(() => ({ body: form.examples, header: [form.header.example] }), [form.examples, form.header.example]);

  const problems = [];
  if (!form.integrationId) problems.push('Elige el chatbot (número) donde se creará');
  if (!slug(form.name)) problems.push('Escribe un nombre');
  if (!form.body.trim()) problems.push('Escribe el cuerpo del mensaje');
  if (bodyVars > 0 && form.examples.some((e) => !e.trim())) problems.push(`Pon un ejemplo para cada variable del cuerpo ({{1}}…{{${bodyVars}}})`);
  if (form.header.type === 'text' && !form.header.text.trim()) problems.push('Escribe la cabecera o quítala');
  if (form.header.type === 'text' && countParams(form.header.text) > 0 && !form.header.example.trim()) problems.push('Pon un ejemplo para la variable de la cabecera');
  if (['image', 'video', 'document'].includes(form.header.type) && !form.header.handle) problems.push('Sube el archivo de ejemplo de la cabecera');
  for (const [i, b] of form.buttons.entries()) {
    if (b.type !== 'copy_code' && !b.text?.trim()) problems.push(`Texto del botón ${i + 1}`);
    if (b.type === 'url' && !/^https?:\/\//i.test(b.url ?? '')) problems.push(`Enlace del botón ${i + 1} (debe empezar por https://)`);
    if (b.type === 'url' && countParams(b.url) > 0 && !b.example?.trim()) problems.push(`Ejemplo del enlace del botón ${i + 1}`);
    if (b.type === 'phone' && !(b.phone ?? '').trim()) problems.push(`Teléfono del botón ${i + 1}`);
    if (b.type === 'copy_code' && !(b.example ?? '').trim()) problems.push('Código de ejemplo del botón de copiar');
  }

  async function submit() {
    setBusy(true);
    try {
      const created = await post('/api/templates', toDraft(form));
      toast(`Plantilla "${created.name}" enviada a revisión de Meta`);
      onDone(created);
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }

  const steps = [{ value: 0, label: '1 · Configurar' }, { value: 1, label: '2 · Contenido' }, { value: 2, label: '3 · Revisar y enviar' }];

  return (
    <Modal
      title="Crear plantilla"
      onClose={onClose}
      wide
      footer={
        <>
          {step > 0 ? <Button onClick={() => setStep(step - 1)}>← Atrás</Button> : null}
          {step < 2 ? <Button variant="primary" onClick={() => setStep(step + 1)} disabled={step === 0 && (!form.integrationId || !slug(form.name))}>Siguiente →</Button> : null}
          {step === 2 ? <Button id="template-submit" variant="primary" onClick={submit} loading={busy} disabled={problems.length > 0}>Enviar a revisión</Button> : null}
        </>
      }
    >
      <Tabs value={step} onChange={setStep} items={steps} />
      <div className="grid cols-2" style={{ marginTop: 12 }}>
        <div className="col" style={{ gap: 12 }}>
          {step === 0 ? (
            <>
              <Field label="Chatbot (número) donde se crea" hint="La plantilla pertenece a la cuenta de WhatsApp de ese número">
                <select id="tb-number" className="select" value={form.integrationId} onChange={(e) => set('integrationId', e.target.value)} disabled={numbers.length === 1}>
                  <option value="">Elige…</option>
                  {numbers.map((n) => <option key={n.id} value={n.id}>{numberLabel(n)}</option>)}
                </select>
              </Field>
              <Field label="Categoría">
                <div className="col" style={{ gap: 6 }}>
                  {CATEGORIES.map((c) => (
                    <label key={c.value} className={`chk-card ${form.category === c.value ? 'on' : ''}`}>
                      <input type="radio" name="tb-cat" checked={form.category === c.value} onChange={() => set('category', c.value)} />
                      <span><strong>{c.label}</strong><small>{c.help}</small></span>
                    </label>
                  ))}
                  <p className="tiny faint">Las de autenticación (códigos OTP) tienen un formato fijo de Meta: créalas en el WhatsApp Manager.</p>
                </div>
              </Field>
              <Field label="Nombre" hint="Minúsculas, números y guion bajo. Se convierte solo.">
                <input id="tb-name" className="input mono" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="promo_septiembre" />
                {form.name && slug(form.name) !== form.name ? <span className="tiny faint">Se enviará como <code>{slug(form.name)}</code></span> : null}
              </Field>
              <Field label="Idioma">
                <select className="select" value={form.language} onChange={(e) => set('language', e.target.value)}>
                  {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label} · {l.value}</option>)}
                </select>
              </Field>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <Field label="Cabecera (opcional)">
                <select className="select" value={form.header.type} onChange={(e) => setHeader({ type: e.target.value, handle: '', fileName: '' })}>
                  {HEADERS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
                </select>
              </Field>
              {form.header.type === 'text' ? (
                <>
                  <Field label="Texto de la cabecera" hint="Máximo 60 caracteres y como mucho una variable {{1}}">
                    <input className="input" maxLength={60} value={form.header.text} onChange={(e) => setHeader({ text: e.target.value })} placeholder="¡Hola {{1}}!" />
                  </Field>
                  {countParams(form.header.text) > 0 ? (
                    <Field label="Ejemplo de {{1}} en la cabecera"><input className="input" value={form.header.example} onChange={(e) => setHeader({ example: e.target.value })} placeholder="Ana" /></Field>
                  ) : null}
                </>
              ) : null}
              {['image', 'video', 'document'].includes(form.header.type) ? (
                <ExampleUpload integrationId={form.integrationId} kind={form.header.type} value={form.header} onChange={(v) => setHeader(v)} />
              ) : null}

              <Field label="Cuerpo del mensaje" hint={`${form.body.length}/1024 · variables {{1}}, {{2}}… en orden; no puede empezar ni terminar con una variable`}>
                <textarea id="tb-body" className="input" rows={6} maxLength={1024} value={form.body} onChange={(e) => set('body', e.target.value)} placeholder={'Hola {{1}}, tu pedido {{2}} ya está listo. ¡Gracias por comprar con nosotros!'} />
                <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                  <Button size="sm" onClick={() => set('body', `${form.body}{{${bodyVars + 1}}}`)}>+ Agregar variable {'{{'}{bodyVars + 1}{'}}'}</Button>
                  <span className="tiny faint">Negrita *así*, cursiva _así_, tachado ~así~.</span>
                </div>
              </Field>
              {form.examples.map((v, i) => (
                <Field key={i} label={`Ejemplo de {{${i + 1}}}`} hint="Meta lo usa para revisar la plantilla; al enviar podrás poner el valor real">
                  <input className="input" value={v} onChange={(e) => set('examples', form.examples.map((x, j) => (j === i ? e.target.value : x)))} />
                </Field>
              ))}
              <Field label="Pie de página (opcional)" hint="Máximo 60 caracteres">
                <input className="input" maxLength={60} value={form.footer} onChange={(e) => set('footer', e.target.value)} placeholder="Responde STOP si no quieres recibir más mensajes" />
              </Field>

              <ButtonsEditor buttons={form.buttons} onChange={(b) => set('buttons', b)} />
            </>
          ) : null}

          {step === 2 ? (
            <>
              <div className="card pad col" style={{ gap: 6 }}>
                <div className="row between"><strong className="mono">{slug(form.name) || '—'}</strong><Badge tone="info">{form.category}</Badge></div>
                <div className="small muted">{number ? numberLabel(number) : 'Sin número'} · {LANGUAGES.find((l) => l.value === form.language)?.label ?? form.language}</div>
                <div className="small">{bodyVars} variable{bodyVars === 1 ? '' : 's'} · {form.buttons.length} botón{form.buttons.length === 1 ? '' : 'es'} · cabecera: {HEADERS.find((h) => h.value === form.header.type)?.label}</div>
              </div>
              {problems.length ? (
                <div className="callout warn small">
                  <strong>Antes de enviar:</strong>
                  <ul style={{ margin: '4px 0 0 18px' }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
                </div>
              ) : (
                <div className="callout small">Meta revisará la plantilla (suele tardar minutos; puede ser hasta 24 h). Quedará en la pestaña <strong>pendiente</strong>; pulsa "Sincronizar con Meta" para ver cuando la aprueben. Si Meta cree que la categoría es otra, la cambia sola.</div>
              )}
              <div className="tiny faint">Reglas de Meta: sin nombres de marca ajenos, sin contenido engañoso, y las de marketing deben ofrecer una forma de dejar de recibir mensajes (p. ej. el pie "Responde STOP").</div>
            </>
          ) : null}
        </div>

        <div className="col tb-side" style={{ gap: 8 }}>
          <span className="label">Vista previa</span>
          <div className="tb-phone">
            <TemplatePreview template={previewTemplate} values={previewValues} />
          </div>
          {form.header.type !== 'none' && form.header.type !== 'text' ? <span className="tiny faint">La cabecera de {HEADERS.find((h) => h.value === form.header.type)?.label.toLowerCase()} se mostrará arriba del texto{form.header.fileName ? ` (ejemplo: ${form.header.fileName})` : ''}.</span> : null}
        </div>
      </div>
    </Modal>
  );
}

/** Sube el archivo de ejemplo de la cabecera y guarda el handle que devuelve Meta. */
function ExampleUpload({ integrationId, kind, value, onChange }) {
  const toast = useToast();
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  async function pick(file) {
    if (!file) return;
    if (!integrationId) return toast('Elige primero el chatbot (paso 1)', { error: true });
    setBusy(true);
    try {
      const form = new FormData();
      form.append('integrationId', integrationId);
      form.append('file', file);
      const r = await api('/api/templates/example', { method: 'POST', body: form, raw: true });
      onChange({ handle: r.handle, fileName: r.name });
      toast('Archivo de ejemplo subido a Meta');
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); if (ref.current) ref.current.value = ''; }
  }
  return (
    <Field label="Archivo de ejemplo" hint={kind === 'image' ? 'JPG o PNG, hasta 5 MB' : kind === 'video' ? 'MP4, hasta 16 MB' : 'PDF, hasta 16 MB'}>
      <div className="row wrap">
        <input ref={ref} type="file" accept={ACCEPT[kind]} style={{ display: 'none' }} onChange={(e) => pick(e.target.files?.[0])} />
        <Button size="sm" onClick={() => ref.current?.click()} loading={busy}><I.clip /> {value.handle ? 'Cambiar archivo' : 'Elegir archivo'}</Button>
        {value.handle ? <Badge tone="ok">{value.fileName || 'subido'}</Badge> : <span className="tiny faint">Meta necesita un ejemplo real para aprobar cabeceras multimedia.</span>}
      </div>
    </Field>
  );
}

const BUTTON_TYPES = [
  { value: 'quick_reply', label: 'Respuesta rápida', help: 'El cliente responde con un toque (hasta 10)' },
  { value: 'url', label: 'Ir a un enlace', help: 'Abre una web (hasta 2). Puede terminar en {{1}} para un enlace por cliente' },
  { value: 'phone', label: 'Llamar', help: 'Llama al número del negocio (1)' },
  { value: 'copy_code', label: 'Copiar código', help: 'Cupón de descuento (1)' },
];

function ButtonsEditor({ buttons, onChange }) {
  const count = (t) => buttons.filter((b) => b.type === t).length;
  const canAdd = (t) => buttons.length < 10 && (t === 'quick_reply' ? true : t === 'url' ? count('url') < 2 : count(t) < 1);
  const add = (type) => onChange([...buttons, { type, text: '', url: type === 'url' ? 'https://' : undefined, phone: '', example: '' }]);
  const update = (i, patch) => onChange(buttons.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const remove = (i) => onChange(buttons.filter((_, j) => j !== i));

  return (
    <Field label="Botones (opcional)" hint="Hasta 10. Las respuestas rápidas van agrupadas al final.">
      <div className="col" style={{ gap: 8 }}>
        {buttons.map((b, i) => (
          <div key={i} className="card pad col" style={{ gap: 6 }}>
            <div className="row between">
              <Badge tone="info">{BUTTON_TYPES.find((t) => t.value === b.type)?.label}</Badge>
              <button type="button" className="btn ghost icon sm" aria-label="Quitar botón" onClick={() => remove(i)}><I.trash /></button>
            </div>
            {b.type !== 'copy_code' ? <input className="input" maxLength={25} placeholder="Texto del botón (máx. 25)" value={b.text} onChange={(e) => update(i, { text: e.target.value })} /> : null}
            {b.type === 'url' ? (
              <>
                <input className="input mono" placeholder="https://tutienda.com/pedido/{{1}}" value={b.url} onChange={(e) => update(i, { url: e.target.value })} />
                {countParams(b.url) > 0 ? <input className="input mono" placeholder="Ejemplo completo: https://tutienda.com/pedido/12345" value={b.example} onChange={(e) => update(i, { example: e.target.value })} /> : null}
              </>
            ) : null}
            {b.type === 'phone' ? <input className="input mono" placeholder="+57 315 3652520" value={b.phone} onChange={(e) => update(i, { phone: e.target.value })} /> : null}
            {b.type === 'copy_code' ? <input className="input mono" maxLength={15} placeholder="Código de ejemplo (p. ej. PROMO10)" value={b.example} onChange={(e) => update(i, { example: e.target.value })} /> : null}
          </div>
        ))}
        <div className="row wrap" style={{ gap: 6 }}>
          {BUTTON_TYPES.map((t) => (
            <Button key={t.value} size="sm" disabled={!canAdd(t.value)} onClick={() => add(t.value)} title={t.help}><I.plus /> {t.label}</Button>
          ))}
        </div>
      </div>
    </Field>
  );
}
