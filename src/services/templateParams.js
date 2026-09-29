/**
 * Parámetros de una plantilla al enviarla (bandeja o campaña).
 *
 * A partir de los componentes sincronizados desde Meta se deduce qué exige
 * la plantilla (variables del cuerpo, cabecera de texto o multimedia, botones
 * de enlace dinámico, código de cupón, catálogo) y se comprueba que los
 * `components` que se van a mandar cumplan. Así una campaña no se guarda con
 * un error que Meta devolvería después (131008, 132001, 132012…).
 */

const VAR_RE = /\{\{\s*(\d+)\s*\}\}/g;
/** {{contact.name}} o {{contact.name|Cliente}} (valor por defecto si el contacto no lo tiene). */
const CONTACT_RE = /\{\{\s*contact\.([\w.]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

export const countVars = (text = '') => new Set([...String(text).matchAll(VAR_RE)].map((m) => Number(m[1]))).size;

/** Qué pide la plantilla. */
export function templateSpec(template) {
  const comps = Array.isArray(template?.components) ? template.components : [];
  const header = comps.find((c) => c.type === 'HEADER');
  const body = comps.find((c) => c.type === 'BODY');
  const buttons = comps.find((c) => c.type === 'BUTTONS')?.buttons ?? [];
  const spec = {
    bodyVars: countVars(body?.text),
    headerFormat: header?.format ?? null,
    headerVars: header?.format === 'TEXT' ? countVars(header.text) : 0,
    urlButtons: [],
    copyCode: null,
    catalog: null,
    unsupported: [],
  };
  buttons.forEach((b, index) => {
    const type = String(b.type ?? '').toUpperCase();
    if (type === 'URL' && countVars(b.url) > 0) spec.urlButtons.push({ index, text: b.text, url: b.url });
    else if (type === 'COPY_CODE') spec.copyCode = { index, text: b.text };
    else if (type === 'CATALOG') spec.catalog = { index, text: b.text };
    else if (['MPM', 'FLOW', 'OTP', 'SPM', 'ORDER_DETAILS', 'VOICE_CALL', 'CALL_PERMISSION_REQUEST'].includes(type)) spec.unsupported.push(type);
  });
  return spec;
}

/**
 * Resuelve {{contact.campo}} y {{contact.campo|defecto}} y deja el texto como
 * Meta lo acepta: sin saltos de línea ni tabulaciones, sin 4+ espacios seguidos.
 */
export function resolveParam(raw, contact) {
  if (typeof raw !== 'string') return raw;
  const resolved = raw.replace(CONTACT_RE, (_, path, fallback) => {
    const value = path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), contact);
    const text = value == null ? '' : String(value).trim();
    return text || (fallback ?? '');
  });
  return resolved.replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
}

/** Placeholders de contacto usados en un texto: [{ path, fallback }]. */
export function contactPlaceholders(text = '') {
  return [...String(text).matchAll(CONTACT_RE)].map((m) => ({ path: m[1], fallback: m[2] ?? null }));
}

const find = (components, type, subType, index) =>
  (components ?? []).find((c) => c.type === type && (subType ? c.sub_type === subType : true) && (index === undefined ? true : String(c.index) === String(index)));

/**
 * Comprueba los componentes contra la plantilla. Devuelve la lista de
 * problemas (vacía si todo está bien) en español, para mostrarla tal cual.
 * `contacts` (opcional): muestra de destinatarios para detectar campos vacíos.
 */
export function validateTemplateComponents(template, components = [], { contacts = [] } = {}) {
  const spec = templateSpec(template);
  const problems = [];
  const name = template?.name ?? 'plantilla';

  if (spec.unsupported.length) {
    problems.push(`La plantilla "${name}" usa botones de tipo ${spec.unsupported.join(', ')} que todavía no se pueden enviar desde el CRM.`);
  }

  const checkText = (label, value) => {
    if (typeof value !== 'string' || !value.trim()) { problems.push(`${label}: está vacío.`); return; }
    if (/[\r\n\t]/.test(value)) problems.push(`${label}: no puede tener saltos de línea ni tabulaciones (Meta lo rechaza, error 132012).`);
    if (/ {4,}/.test(value)) problems.push(`${label}: no puede tener 4 o más espacios seguidos (error 132012).`);
    if (value.length > 1024) problems.push(`${label}: supera los 1024 caracteres.`);
  };

  // Placeholders de contacto sin valor en algunos destinatarios.
  const checkContacts = (label, value) => {
    if (typeof value !== 'string' || !contacts.length) return;
    for (const ph of contactPlaceholders(value)) {
      if (ph.fallback) continue;
      const missing = contacts.filter((c) => {
        const v = ph.path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), c);
        return v == null || !String(v).trim();
      }).length;
      if (missing > 0) {
        problems.push(`${label}: ${missing} de ${contacts.length} destinatarios no tienen "${ph.path}" y el parámetro quedaría vacío. Usa {{contact.${ph.path}|Cliente}} para poner un valor por defecto.`);
      }
    }
  };

  // Cuerpo
  const body = find(components, 'body');
  const bodyParams = body?.parameters ?? [];
  if (spec.bodyVars !== bodyParams.length) {
    problems.push(`El cuerpo de "${name}" tiene ${spec.bodyVars} variable${spec.bodyVars === 1 ? '' : 's'} y se ${bodyParams.length === 1 ? 'envía' : 'envían'} ${bodyParams.length}.`);
  }
  bodyParams.forEach((p, i) => {
    if (p.type !== 'text') { problems.push(`Parámetro {{${i + 1}}} del cuerpo: debe ser de texto.`); return; }
    checkText(`Parámetro {{${i + 1}}} del cuerpo`, p.text);
    checkContacts(`Parámetro {{${i + 1}}} del cuerpo`, p.text);
  });

  // Cabecera
  const header = find(components, 'header');
  const headerParam = header?.parameters?.[0];
  if (spec.headerFormat === 'TEXT') {
    if (spec.headerVars > 0) {
      if (!headerParam || headerParam.type !== 'text') problems.push('La cabecera tiene una variable {{1}} y falta su valor.');
      else { checkText('Variable de la cabecera', headerParam.text); checkContacts('Variable de la cabecera', headerParam.text); }
    }
  } else if (spec.headerFormat && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(spec.headerFormat)) {
    const kind = spec.headerFormat.toLowerCase();
    const media = headerParam?.[kind];
    if (!headerParam || headerParam.type !== kind || !(media?.link || media?.id)) {
      problems.push(`La plantilla lleva cabecera de ${kind === 'image' ? 'imagen' : kind === 'video' ? 'video' : 'documento'}: indica el enlace público (https) del archivo que se enviará.`);
    } else if (media.link && !/^https:\/\//i.test(media.link)) {
      problems.push('El enlace de la cabecera debe empezar por https://');
    }
  }

  // Botones de enlace dinámico
  for (const b of spec.urlButtons) {
    const comp = find(components, 'button', 'url', b.index);
    const p = comp?.parameters?.[0];
    if (!p || p.type !== 'text') problems.push(`El botón "${b.text}" tiene un enlace con variable: falta el valor que la reemplaza.`);
    else { checkText(`Enlace del botón "${b.text}"`, p.text); checkContacts(`Enlace del botón "${b.text}"`, p.text); }
  }

  // Copiar código
  if (spec.copyCode) {
    const comp = find(components, 'button', 'copy_code', spec.copyCode.index);
    const code = comp?.parameters?.[0]?.coupon_code;
    if (!code) problems.push('La plantilla tiene un botón de copiar código: indica el código del cupón.');
    else if (!/^[A-Za-z0-9_-]{1,15}$/.test(code)) problems.push('El código del cupón admite hasta 15 letras o números.');
  }

  // Catálogo
  if (spec.catalog) {
    const comp = find(components, 'button', 'catalog', spec.catalog.index);
    const id = comp?.parameters?.[0]?.action?.thumbnail_product_retailer_id;
    if (!id) problems.push('La plantilla es de catálogo: indica el ID (retailer id) del producto que se muestra como portada.');
  }

  // Componentes de más
  for (const c of components ?? []) {
    if (c.type === 'body' || c.type === 'header') continue;
    if (c.type === 'button') {
      const ok = (c.sub_type === 'url' && spec.urlButtons.some((b) => String(b.index) === String(c.index)))
        || (c.sub_type === 'copy_code' && spec.copyCode)
        || (c.sub_type === 'catalog' && spec.catalog)
        || c.sub_type === 'quick_reply';
      if (!ok) problems.push(`Se envía un botón (${c.sub_type ?? '?'} #${c.index}) que la plantilla no tiene.`);
      continue;
    }
    problems.push(`Componente desconocido: ${c.type}.`);
  }

  return { ok: problems.length === 0, problems, spec };
}

/** Sustituye los parámetros de texto y los placeholders de contacto en todos los componentes. */
export function buildComponentsFor(components, contact) {
  if (!Array.isArray(components)) return [];
  return components.map((component) => ({
    ...component,
    parameters: (component.parameters ?? []).map((param) =>
      param.type === 'text' ? { ...param, text: resolveParam(param.text, contact) } : param
    ),
  }));
}
