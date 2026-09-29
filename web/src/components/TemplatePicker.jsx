import React, { useEffect, useMemo, useState } from 'react';
import { get } from '../api.js';
import { Button, Field, Modal, Empty, Loading, Badge } from './ui.jsx';

/** Cuenta los {{n}} de un texto de plantilla. */
export function countParams(text = '') {
  const found = new Set();
  for (const m of String(text).matchAll(/\{\{\s*(\d+)\s*\}\}/g)) found.add(Number(m[1]));
  return found.size;
}

/** Sustituye {{n}} por los valores dados, para la vista previa. */
export function fillParams(text = '', values = []) {
  return String(text).replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => values[Number(n) - 1] || `{{${n}}}`);
}

/**
 * Qué pide la plantilla: variables del cuerpo, cabecera (texto con variable o
 * imagen/video/documento), botones de enlace dinámico, cupón, catálogo y tipos
 * que el CRM no puede enviar.
 */
export function templateSpec(template) {
  const comps = template?.components ?? [];
  const header = comps.find((c) => c.type === 'HEADER');
  const body = comps.find((c) => c.type === 'BODY');
  const buttons = comps.find((c) => c.type === 'BUTTONS')?.buttons ?? [];
  const spec = { bodyVars: countParams(body?.text), headerFormat: header?.format ?? null, headerVars: header?.format === 'TEXT' ? countParams(header.text) : 0, urlButtons: [], copyCode: null, catalog: null, unsupported: [] };
  buttons.forEach((b, index) => {
    const type = String(b.type ?? '').toUpperCase();
    if (type === 'URL' && countParams(b.url) > 0) spec.urlButtons.push({ index, text: b.text, url: b.url });
    else if (type === 'COPY_CODE') spec.copyCode = { index, text: b.text };
    else if (type === 'CATALOG') spec.catalog = { index, text: b.text };
    else if (['MPM', 'FLOW', 'OTP', 'SPM', 'ORDER_DETAILS', 'VOICE_CALL', 'CALL_PERMISSION_REQUEST'].includes(type)) spec.unsupported.push(type);
  });
  return spec;
}

/** Valores vacíos para una plantilla (con el nombre del contacto como primer parámetro, si se pasa). */
export function emptyValues(template, { firstBody = '' } = {}) {
  const spec = templateSpec(template);
  const body = Array(spec.bodyVars).fill('');
  if (body.length && firstBody) body[0] = firstBody;
  return { header: Array(spec.headerVars).fill(''), headerMedia: '', body, buttons: {}, couponCode: '', catalogThumbnail: '' };
}

/**
 * Construye los "components" que la Cloud API espera a partir de los valores:
 * cabecera de texto o multimedia (enlace https), cuerpo, botones de URL
 * dinámica, cupón (copy_code) y catálogo (producto de portada).
 */
export function buildComponents(template, { header = [], headerMedia = '', body = [], buttons = {}, couponCode = '', catalogThumbnail = '' } = {}) {
  const out = [];
  const spec = templateSpec(template);

  if (spec.headerFormat === 'TEXT' && spec.headerVars > 0 && header.length) {
    out.push({ type: 'header', parameters: header.slice(0, spec.headerVars).map((text) => ({ type: 'text', text })) });
  } else if (spec.headerFormat && spec.headerFormat !== 'TEXT' && headerMedia) {
    const kind = spec.headerFormat.toLowerCase();
    out.push({ type: 'header', parameters: [{ type: kind, [kind]: { link: headerMedia } }] });
  }
  if (spec.bodyVars > 0) {
    out.push({ type: 'body', parameters: body.slice(0, spec.bodyVars).map((text) => ({ type: 'text', text })) });
  }
  for (const b of spec.urlButtons) {
    if (buttons[b.index]) out.push({ type: 'button', sub_type: 'url', index: String(b.index), parameters: [{ type: 'text', text: buttons[b.index] }] });
  }
  if (spec.copyCode && couponCode) {
    out.push({ type: 'button', sub_type: 'copy_code', index: String(spec.copyCode.index), parameters: [{ type: 'coupon_code', coupon_code: couponCode }] });
  }
  if (spec.catalog && catalogThumbnail) {
    out.push({ type: 'button', sub_type: 'catalog', index: String(spec.catalog.index), parameters: [{ type: 'action', action: { thumbnail_product_retailer_id: catalogThumbnail } }] });
  }
  return out;
}

/** ¿Están todos los valores que la plantilla exige? */
export function valuesComplete(template, values) {
  const spec = templateSpec(template);
  if (spec.unsupported.length) return false;
  if (!values.body.slice(0, spec.bodyVars).every((v) => v && v.trim())) return false;
  if (spec.headerFormat === 'TEXT' && !values.header.slice(0, spec.headerVars).every((v) => v && v.trim())) return false;
  if (spec.headerFormat && spec.headerFormat !== 'TEXT' && !/^https:\/\//i.test(values.headerMedia ?? '')) return false;
  if (!spec.urlButtons.every((b) => values.buttons[b.index]?.trim())) return false;
  if (spec.copyCode && !values.couponCode?.trim()) return false;
  if (spec.catalog && !values.catalogThumbnail?.trim()) return false;
  return true;
}

/**
 * Campos para llenar los parámetros de una plantilla. Se usa en la bandeja
 * (envío a un contacto) y en campañas (con {{contact.name|Cliente}}).
 */
export function TemplateParamsFields({ template, values, onChange, campaign = false }) {
  const spec = templateSpec(template);
  const set = (patch) => onChange({ ...values, ...patch });
  const hint = campaign ? 'Puedes usar {{contact.name|Cliente}} (con valor por defecto) o {{contact.customFields.campo}}' : undefined;
  const nothing = spec.bodyVars === 0 && spec.headerVars === 0 && !spec.headerFormat && !spec.urlButtons.length && !spec.copyCode && !spec.catalog;

  return (
    <div className="col" style={{ gap: 10 }}>
      {spec.unsupported.length ? <div className="callout crit small">Esta plantilla usa botones de tipo {spec.unsupported.join(', ')} que el CRM todavía no puede enviar. Elige otra.</div> : null}
      {spec.headerFormat && spec.headerFormat !== 'TEXT' ? (
        <Field label={`Cabecera: ${spec.headerFormat === 'IMAGE' ? 'imagen' : spec.headerFormat === 'VIDEO' ? 'video' : 'documento'}`} hint="Enlace público https:// al archivo (JPG/PNG, MP4 o PDF) que verá el cliente">
          <input className="input mono" value={values.headerMedia ?? ''} onChange={(e) => set({ headerMedia: e.target.value })} placeholder="https://tu-sitio.com/promo.jpg" />
        </Field>
      ) : null}
      {spec.headerFormat === 'TEXT' && spec.headerVars > 0 ? values.header.slice(0, spec.headerVars).map((v, i) => (
        <Field key={`h${i}`} label={`Cabecera {{${i + 1}}}`} hint={hint}>
          <input className="input" value={v} onChange={(e) => set({ header: values.header.map((x, j) => (j === i ? e.target.value : x)) })} />
        </Field>
      )) : null}
      {values.body.slice(0, spec.bodyVars).map((v, i) => (
        <Field key={`b${i}`} label={`Parámetro {{${i + 1}}}`} hint={hint}>
          <input className="input" value={v} onChange={(e) => set({ body: values.body.map((x, j) => (j === i ? e.target.value : x)) })} />
        </Field>
      ))}
      {spec.urlButtons.map((b) => (
        <Field key={`u${b.index}`} label={`URL del botón "${b.text}"`} hint={`Se completa ${b.url}`}>
          <input className="input mono" value={values.buttons[b.index] ?? ''} onChange={(e) => set({ buttons: { ...values.buttons, [b.index]: e.target.value } })} />
        </Field>
      ))}
      {spec.copyCode ? (
        <Field label="Código del cupón" hint="Hasta 15 letras o números; es lo que copia el botón">
          <input className="input mono" maxLength={15} value={values.couponCode ?? ''} onChange={(e) => set({ couponCode: e.target.value })} placeholder="PROMO10" />
        </Field>
      ) : null}
      {spec.catalog ? (
        <Field label="Producto de portada del catálogo" hint="ID del producto (retailer id / SKU) tal como está en el catálogo de Meta">
          <input className="input mono" value={values.catalogThumbnail ?? ''} onChange={(e) => set({ catalogThumbnail: e.target.value })} placeholder="hamburguesa-clasica" />
        </Field>
      ) : null}
      {nothing ? <p className="small muted">Esta plantilla no tiene parámetros.</p> : null}
    </div>
  );
}

export function TemplatePreview({ template, values }) {
  const comps = template.components ?? [];
  const header = comps.find((c) => c.type === 'HEADER');
  const body = comps.find((c) => c.type === 'BODY');
  const footer = comps.find((c) => c.type === 'FOOTER');
  const buttons = comps.find((c) => c.type === 'BUTTONS');
  return (
    <div className="msg outbound" style={{ maxWidth: '100%', alignSelf: 'stretch' }}>
      {header?.format === 'TEXT' ? <div className="ihead">{fillParams(header.text, values?.header)}</div> : null}
      {header && header.format !== 'TEXT' ? <div className="badge">{header.format.toLowerCase()}{values?.headerMedia ? ' · enlace listo' : ''}</div> : null}
      <div>{fillParams(body?.text, values?.body)}</div>
      {footer?.text ? <div className="ifoot">{footer.text}</div> : null}
      {(buttons?.buttons ?? []).map((b, i) => <span key={i} className="ibtn">{b.text ?? b.type}</span>)}
    </div>
  );
}

/**
 * Modal para elegir una plantilla aprobada, llenar sus parámetros y enviarla.
 * onSend recibe { name, language, components }.
 */
export function TemplatePicker({ onClose, onSend, contact, integrationId = null }) {
  const [templates, setTemplates] = useState(null);
  const [selected, setSelected] = useState(null);
  const [values, setValues] = useState(emptyValues(null));
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');

  // Solo las plantillas del número por el que va este chat (cada chatbot tiene las suyas).
  useEffect(() => {
    get(`/api/templates?status=approved${integrationId ? `&integrationId=${integrationId}` : ''}`).then((d) => setTemplates(d.items)).catch(() => setTemplates([]));
  }, [integrationId]);

  const filtered = useMemo(
    () => (templates ?? []).filter((t) => !query || t.name.includes(query.toLowerCase())),
    [templates, query]
  );

  function choose(t) {
    setSelected(t);
    // Comodidad: el primer parámetro suele ser el nombre del cliente.
    setValues(emptyValues(t, { firstBody: contact?.name ?? '' }));
  }

  const complete = selected ? valuesComplete(selected, values) : false;

  async function send() {
    setBusy(true);
    try {
      await onSend({ name: selected.name, language: selected.language, components: buildComponents(selected, values) });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={selected ? `Plantilla: ${selected.name}` : 'Enviar plantilla'}
      onClose={onClose}
      wide
      footer={
        selected ? (
          <>
            <Button onClick={() => setSelected(null)}>← Elegir otra</Button>
            <Button variant="primary" onClick={send} loading={busy} disabled={!complete}>Enviar plantilla</Button>
          </>
        ) : null
      }
    >
      {!selected ? (
        <>
          <input className="input" placeholder="Buscar por nombre…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {templates === null ? <Loading /> : null}
          {templates !== null && filtered.length === 0 ? (
            <Empty title="No hay plantillas aprobadas para este número">Sincroniza las plantillas de este chatbot desde la página de Plantillas.</Empty>
          ) : null}
          <div className="col">
            {filtered.map((t) => (
              <button key={t.id} className="card pad" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit' }} onClick={() => choose(t)}>
                <div className="row between">
                  <strong>{t.name}</strong>
                  <span className="row"><Badge>{t.language}</Badge><Badge tone="info">{t.category}</Badge></span>
                </div>
                <div className="small muted" style={{ marginTop: 4 }}>{t.components?.find((c) => c.type === 'BODY')?.text?.slice(0, 160)}</div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="grid cols-2">
          <div className="col">
            <TemplateParamsFields template={selected} values={values} onChange={setValues} />
          </div>
          <div className="col">
            <span className="label">Vista previa</span>
            <TemplatePreview template={selected} values={values} />
          </div>
        </div>
      )}
    </Modal>
  );
}
