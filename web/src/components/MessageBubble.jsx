import React, { useState } from 'react';
import { mediaUrl } from '../api.js';
import { fmtTime, STATUS_LABEL } from './ui.jsx';
import { I } from './Icons.jsx';

/**
 * Pinta cualquier mensaje de WhatsApp: texto, multimedia, ubicación, contactos,
 * respuestas a botones/listas/flows, pedidos del catálogo, reacciones,
 * plantillas y mensajes interactivos salientes. Los entrantes vienen con el
 * formato crudo de Meta; los salientes con el formato interno del CRM.
 */

const MEDIA = new Set(['image', 'video', 'audio', 'document', 'sticker']);
const money = (amount, currency) =>
  amount == null ? '' : new Intl.NumberFormat('es-CO', { style: 'currency', currency: currency || 'COP', maximumFractionDigits: 0 }).format(amount);

/**
 * Reproductor de audio con estado de error legible. Si el archivo no carga
 * (se perdió del servidor, formato no soportado…), en vez del "Error" mudo del
 * navegador muestra el motivo, un botón para reintentar y la descarga.
 */
function AudioPlayer({ src, voice = false }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(null);
  const url = attempt ? `${src}&r=${attempt}` : src;

  if (failed) {
    return (
      <div className="audio-failed">
        <span>{failed}</span>
        <span className="row" style={{ gap: 6 }}>
          <button type="button" className="btn sm" onClick={() => { setFailed(null); setAttempt((a) => a + 1); }}>Reintentar</button>
          <a className="btn sm" href={url} download>Descargar</a>
        </span>
      </div>
    );
  }
  return (
    <audio
      key={url}
      src={url}
      controls
      preload="metadata"
      title={voice ? 'Nota de voz' : 'Audio'}
      onError={(e) => {
        const code = e.currentTarget?.error?.code;
        // 4 = formato no soportado o archivo no disponible (404); 2 = red.
        setFailed(code === 4 ? 'No se pudo cargar el audio: el archivo no está disponible o este navegador no reproduce el formato.' : 'No se pudo cargar el audio (error de red).');
      }}
    />
  );
}

function Media({ message, raw }) {
  const type = message.type;
  const info = raw?.[type] ?? message.content?.media ?? {};
  const caption = info.caption ?? null;
  // Con id de Meta basta: si el archivo no está en el servidor, el CRM lo vuelve a pedir.
  const hasFile = Boolean(message.mediaStorageKey || message.mediaId);
  const src = hasFile ? mediaUrl(message.id) : info.link ?? null;
  const filename = message.mediaFilename ?? info.filename ?? 'archivo';

  if (!src) {
    return (
      <div className="doc">
        <I.doc />
        <div>
          <div>{type === 'sticker' ? 'Sticker' : filename}</div>
          <div className="tiny faint">{hasFile ? '' : 'Archivo pendiente de descarga'}</div>
        </div>
      </div>
    );
  }
  if (type === 'image' || type === 'sticker') {
    return (
      <>
        <a href={src} target="_blank" rel="noreferrer"><img className="media" src={src} alt={caption ?? 'Imagen'} loading="lazy" /></a>
        {caption ? <div className="caption">{caption}</div> : null}
      </>
    );
  }
  if (type === 'video') {
    return (
      <>
        <video className="media" src={src} controls preload="metadata" />
        {caption ? <div className="caption">{caption}</div> : null}
      </>
    );
  }
  if (type === 'audio') {
    return <AudioPlayer src={src} voice={Boolean(info.voice)} />;
  }
  return (
    <a className="doc" href={src} target="_blank" rel="noreferrer" download={filename}>
      <I.doc />
      <div>
        <div>{filename}</div>
        <div className="tiny faint">{message.mediaMimeType ?? 'Documento'}{message.mediaSizeBytes ? ` · ${Math.round(message.mediaSizeBytes / 1024)} KB` : ''}</div>
      </div>
    </a>
  );
}

function InteractiveInbound({ interactive }) {
  if (interactive.type === 'button_reply') return <div><span className="badge accent">Botón</span> {interactive.button_reply?.title}</div>;
  if (interactive.type === 'list_reply') {
    return (
      <div>
        <span className="badge accent">Opción</span> {interactive.list_reply?.title}
        {interactive.list_reply?.description ? <div className="small muted">{interactive.list_reply.description}</div> : null}
      </div>
    );
  }
  if (interactive.type === 'nfm_reply') {
    let data = {};
    try { data = JSON.parse(interactive.nfm_reply?.response_json ?? '{}'); } catch { data = {}; }
    const entries = Object.entries(data).filter(([k]) => k !== 'flow_token');
    return (
      <div>
        <span className="badge info">Formulario (Flow)</span>
        {interactive.nfm_reply?.body ? <div className="small muted">{interactive.nfm_reply.body}</div> : null}
        {entries.length ? (
          <dl className="kv">
            {entries.map(([k, v]) => (
              <React.Fragment key={k}><dt>{k}</dt><dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd></React.Fragment>
            ))}
          </dl>
        ) : null}
      </div>
    );
  }
  return <div className="muted">[respuesta interactiva]</div>;
}

function InteractiveOutbound({ interactive }) {
  const header = interactive.header?.text ?? null;
  const body = interactive.body?.text ?? '';
  const footer = interactive.footer?.text ?? null;
  const action = interactive.action ?? {};
  return (
    <div>
      {header ? <div className="ihead">{header}</div> : null}
      <div>{body}</div>
      {footer ? <div className="ifoot">{footer}</div> : null}
      {(action.buttons ?? []).map((b, i) => (
        <span key={i} className="ibtn">{b.reply?.title ?? b.title ?? 'Botón'}</span>
      ))}
      {action.button ? <span className="ibtn">☰ {action.button}</span> : null}
      {(action.sections ?? []).map((s, i) => (
        <div key={i} className="small muted" style={{ marginTop: 6 }}>
          {s.title ? <div style={{ fontWeight: 500 }}>{s.title}</div> : null}
          {(s.rows ?? []).map((r) => <div key={r.id}>• {r.title}</div>)}
        </div>
      ))}
      {interactive.type === 'flow' ? <span className="ibtn">{action.parameters?.flow_cta ?? 'Abrir formulario'}</span> : null}
      {interactive.type === 'cta_url' ? <a className="ibtn" href={action.parameters?.url} target="_blank" rel="noreferrer">{action.parameters?.display_text ?? 'Abrir enlace'}</a> : null}
    </div>
  );
}

function Template({ template }) {
  const params = (template.components ?? [])
    .flatMap((c) => (c.parameters ?? []).map((p) => p.text ?? p.payload ?? (p.image ? '[imagen]' : p.document ? '[documento]' : '')))
    .filter(Boolean);
  return (
    <div>
      <div className="tpl">plantilla · {template.name} · {template.language}</div>
      {params.length ? <div className="small">{params.join(' · ')}</div> : <div className="small muted">Sin parámetros</div>}
    </div>
  );
}

function Order({ order }) {
  const items = order.product_items ?? [];
  const total = items.reduce((sum, it) => sum + (Number(it.item_price) || 0) * (Number(it.quantity) || 0), 0);
  const currency = items[0]?.currency;
  return (
    <div>
      <span className="badge info">Pedido del catálogo</span>
      {order.text ? <div className="small muted" style={{ marginTop: 4 }}>{order.text}</div> : null}
      <div style={{ marginTop: 6 }}>
        {items.map((it, i) => (
          <div key={i} className="order-line">
            <span>{it.quantity} × {it.product_retailer_id}</span>
            <span className="tabular">{money(it.item_price * it.quantity, it.currency)}</span>
          </div>
        ))}
      </div>
      <div className="order-total"><span>Total estimado</span><span className="tabular">{money(total, currency)}</span></div>
    </div>
  );
}

function Body({ message }) {
  const raw = message.content ?? {};
  const type = message.type;
  const isInternal = message.direction === 'outbound' && (message.source === 'agent' || message.source === 'bot' || message.source === 'campaign');

  if (isInternal) {
    if (type === 'text') return <div>{message.text ?? raw.text}</div>;
    if (type === 'template' && raw.template) return <Template template={raw.template} />;
    if (type === 'interactive' && raw.interactive) return <InteractiveOutbound interactive={raw.interactive} />;
    if (MEDIA.has(type)) return <Media message={message} raw={null} />;
    if (type === 'location' && raw.location) return <div><I.pin /> {raw.location.name ?? `${raw.location.latitude}, ${raw.location.longitude}`}</div>;
    if (type === 'contacts' && Array.isArray(raw.contacts)) {
      return (
        <div>
          {raw.contacts.map((c, i) => (
            <div key={i}><I.user /> {c.name?.formatted_name}{c.phones?.[0]?.phone ? ` · ${c.phones[0].phone}` : ''}</div>
          ))}
        </div>
      );
    }
    if (type === 'reaction') return <div style={{ fontSize: '1.4rem' }}>{raw.reaction?.emoji ?? '👍'}</div>;
    return <div className="muted">[{type}]</div>;
  }

  // Formato crudo de Meta (entrantes, ecos de la app, historial)
  if (type === 'text') return <div>{raw.text?.body ?? message.text}</div>;
  if (MEDIA.has(type)) return <Media message={message} raw={raw} />;
  if (type === 'interactive' && raw.interactive) return <InteractiveInbound interactive={raw.interactive} />;
  if (type === 'button') return <div><span className="badge accent">Respuesta rápida</span> {raw.button?.text}</div>;
  if (type === 'order' && raw.order) return <Order order={raw.order} />;
  if (type === 'location' && raw.location) {
    const { latitude, longitude, name, address } = raw.location;
    return (
      <a href={`https://maps.google.com/?q=${latitude},${longitude}`} target="_blank" rel="noreferrer" className="row">
        <I.pin /> <span>{name ?? 'Ubicación'}{address ? ` · ${address}` : ''}</span>
      </a>
    );
  }
  if (type === 'contacts' && Array.isArray(raw.contacts)) {
    return (
      <div>
        {raw.contacts.map((c, i) => (
          <div key={i}><I.user /> {c.name?.formatted_name}{c.phones?.[0]?.phone ? ` · ${c.phones[0].phone}` : ''}</div>
        ))}
      </div>
    );
  }
  if (type === 'reaction') return <div style={{ fontSize: '1.4rem' }}>{raw.reaction?.emoji ?? '👍'}</div>;
  if (type === 'system') return <div>{raw.system?.body ?? 'Evento del sistema'}</div>;
  if (type === 'unsupported' || raw.errors) return <div className="muted">Mensaje no soportado por la API{raw.errors?.[0]?.title ? `: ${raw.errors[0].title}` : ''}</div>;
  if (type === 'template') return <Template template={raw.template ?? { name: 'plantilla', language: '' }} />;
  return <div className="muted">[{type}]</div>;
}

export function MessageBubble({ message }) {
  const raw = message.content ?? {};
  const isSystem = message.type === 'system' || message.type === 'reaction';
  const cls = isSystem ? 'system' : message.direction;
  const sourceLabel =
    message.source === 'bot' ? 'bot'
      : message.source === 'campaign' ? 'campaña'
      : message.source === 'smb_echo' ? 'desde la app'
      : message.source === 'history' ? 'historial'
      : null;

  return (
    <div className={`msg ${cls}`} data-msg={message.id}>
      {raw.context?.id ? <div className="reply-ref">↩ En respuesta a un mensaje anterior</div> : null}
      <Body message={message} />
      <div className="meta">
        {sourceLabel ? <span>{sourceLabel}</span> : null}
        <span>{fmtTime(message.createdAt)}</span>
        {message.direction === 'outbound' && !isSystem ? <span className="status">{STATUS_LABEL[message.status] ?? message.status}</span> : null}
      </div>
      {message.status === 'failed' || message.errorMessage ? (
        <div className="msg-error" role="alert">
          <strong>No se entregó.</strong> {explainError(message.errorCode, message.errorMessage)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Mensajes guardados antes de la v2.6 tienen el título en inglés de Meta
 * ("Re-engagement message"). Los códigos más comunes se traducen aquí también.
 */
const CLIENT_ERRORS = {
  131047: 'Fuera de la ventana de 24 h: este número no le escribió al bot en las últimas 24 h, así que WhatsApp solo acepta una plantilla aprobada.',
  470: 'Fuera de la ventana de 24 h: solo se acepta una plantilla aprobada.',
  131026: 'No se pudo entregar: el número no tiene WhatsApp o bloqueó al negocio.',
  131049: 'WhatsApp limitó el envío de marketing a este usuario. Reintenta más tarde.',
  131050: 'El usuario pidió no recibir mensajes de marketing.',
  132000: 'La cantidad de variables no coincide con la plantilla aprobada.',
  132001: 'La plantilla no existe en ese idioma o no está aprobada.',
  132012: 'Una variable de la plantilla tiene formato inválido (saltos de línea o espacios seguidos).',
  133010: 'El número no está registrado en la Cloud API.',
  190: 'El token de Meta venció: reconecta el número.',
};
function explainError(code, message) {
  const known = CLIENT_ERRORS[Number(code)];
  if (known && !(message || '').startsWith(known.slice(0, 20))) return `${known} (${message || `código ${code}`})`;
  return message || (code ? `código ${code}` : 'sin detalle');
}
