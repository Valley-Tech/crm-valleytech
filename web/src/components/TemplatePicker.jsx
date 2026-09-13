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
 * Construye los "components" que la Cloud API espera a partir de los valores
 * escritos. Solo cubre parámetros de texto de cabecera y cuerpo, que es lo que
 * usa el 95 % de las plantillas; los botones con URL dinámica se agregan igual.
 */
export function buildComponents(template, { header = [], body = [], buttons = {} } = {}) {
  const out = [];
  const comps = template.components ?? [];
  const headerComp = comps.find((c) => c.type === 'HEADER');
  const bodyComp = comps.find((c) => c.type === 'BODY');
  const buttonComp = comps.find((c) => c.type === 'BUTTONS');

  if (headerComp?.format === 'TEXT' && header.length) {
    out.push({ type: 'header', parameters: header.map((text) => ({ type: 'text', text })) });
  }
  if (bodyComp && body.length) {
    out.push({ type: 'body', parameters: body.map((text) => ({ type: 'text', text })) });
  }
  (buttonComp?.buttons ?? []).forEach((btn, index) => {
    if (btn.type === 'URL' && countParams(btn.url) > 0 && buttons[index]) {
      out.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: buttons[index] }] });
    }
  });
  return out;
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
      {header && header.format !== 'TEXT' ? <div className="badge">{header.format.toLowerCase()}</div> : null}
      <div>{fillParams(body?.text, values?.body)}</div>
      {footer?.text ? <div className="ifoot">{footer.text}</div> : null}
      {(buttons?.buttons ?? []).map((b, i) => <span key={i} className="ibtn">{b.text}</span>)}
    </div>
  );
}

/**
 * Modal para elegir una plantilla aprobada, llenar sus parámetros y enviarla.
 * onSend recibe { name, language, components }.
 */
export function TemplatePicker({ onClose, onSend, contact }) {
  const [templates, setTemplates] = useState(null);
  const [selected, setSelected] = useState(null);
  const [values, setValues] = useState({ header: [], body: [], buttons: {} });
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    get('/api/templates?status=approved').then((d) => setTemplates(d.items)).catch(() => setTemplates([]));
  }, []);

  const comps = selected?.components ?? [];
  const headerComp = comps.find((c) => c.type === 'HEADER');
  const bodyComp = comps.find((c) => c.type === 'BODY');
  const buttonComp = comps.find((c) => c.type === 'BUTTONS');
  const headerN = headerComp?.format === 'TEXT' ? countParams(headerComp.text) : 0;
  const bodyN = countParams(bodyComp?.text);
  const urlButtons = (buttonComp?.buttons ?? []).map((b, i) => ({ ...b, index: i })).filter((b) => b.type === 'URL' && countParams(b.url) > 0);

  const filtered = useMemo(
    () => (templates ?? []).filter((t) => !query || t.name.includes(query.toLowerCase())),
    [templates, query]
  );

  function choose(t) {
    setSelected(t);
    const body = Array(countParams(t.components?.find((c) => c.type === 'BODY')?.text)).fill('');
    // Comodidad: el primer parámetro suele ser el nombre del cliente.
    if (body.length && contact?.name) body[0] = contact.name;
    setValues({ header: Array(headerN).fill(''), body, buttons: {} });
  }

  const complete = values.body.every(Boolean) && values.header.slice(0, headerN).every(Boolean);

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
            <Empty title="No hay plantillas aprobadas">Sincroniza las plantillas desde la página de Plantillas.</Empty>
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
            {headerN > 0 ? values.header.map((v, i) => (
              <Field key={`h${i}`} label={`Cabecera {{${i + 1}}}`}>
                <input className="input" value={v} onChange={(e) => setValues((s) => ({ ...s, header: s.header.map((x, j) => (j === i ? e.target.value : x)) }))} />
              </Field>
            )) : null}
            {bodyN === 0 ? <p className="small muted">Esta plantilla no tiene parámetros.</p> : null}
            {values.body.map((v, i) => (
              <Field key={`b${i}`} label={`Parámetro {{${i + 1}}}`}>
                <input className="input" value={v} onChange={(e) => setValues((s) => ({ ...s, body: s.body.map((x, j) => (j === i ? e.target.value : x)) }))} />
              </Field>
            ))}
            {urlButtons.map((b) => (
              <Field key={`u${b.index}`} label={`URL del botón "${b.text}"`} hint={b.url}>
                <input className="input" value={values.buttons[b.index] ?? ''} onChange={(e) => setValues((s) => ({ ...s, buttons: { ...s.buttons, [b.index]: e.target.value } }))} />
              </Field>
            ))}
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
