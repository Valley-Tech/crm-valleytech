import { z } from 'zod';
import { badRequest } from '../lib/errors.js';

/**
 * Constructor de plantillas: convierte el borrador que llena el usuario en el
 * CRM (cabecera, cuerpo, pie, botones) en el JSON que la API de Meta espera
 * en POST /{WABA_ID}/message_templates, aplicando las mismas reglas que el
 * WhatsApp Manager para que la plantilla no rebote antes de la revisión.
 *
 * Límites de Meta: nombre ≤ 512 (a-z, 0-9, _), cabecera de texto ≤ 60,
 * cuerpo ≤ 1024, pie ≤ 60, texto de botón ≤ 25, hasta 10 botones (máximo
 * 2 de URL, 1 de teléfono, 1 de copiar código), variables {{1}}, {{2}}…
 * consecutivas y con un ejemplo cada una.
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

const NAME_RE = /^[a-z0-9_]+$/;
const VAR_RE = /\{\{\s*(\d+)\s*\}\}/g;

const button = z.discriminatedUnion('type', [
  z.object({ type: z.literal('quick_reply'), text: z.string().trim().min(1).max(25) }),
  z.object({ type: z.literal('url'), text: z.string().trim().min(1).max(25), url: z.string().trim().min(1).max(2000), example: z.string().trim().max(2000).optional() }),
  z.object({ type: z.literal('phone'), text: z.string().trim().min(1).max(25), phone: z.string().trim().min(5).max(20) }),
  z.object({ type: z.literal('copy_code'), text: z.string().trim().max(25).optional(), example: z.string().trim().min(1).max(15) }),
]);

export const templateDraftSchema = z.object({
  integrationId: z.string().uuid(),
  name: z.string().trim().min(1).max(512),
  language: z.string().trim().min(2).max(10).default('es_CO'),
  category: z.enum(['MARKETING', 'UTILITY']),
  allowCategoryChange: z.boolean().default(true),
  header: z
    .object({
      type: z.enum(['none', 'text', 'image', 'video', 'document']).default('none'),
      text: z.string().trim().max(60).optional(),
      example: z.string().trim().max(60).optional(),
      handle: z.string().trim().max(500).optional(),
    })
    .default({ type: 'none' }),
  body: z.object({
    text: z.string().trim().min(1).max(1024),
    examples: z.array(z.string().trim().max(200)).max(30).default([]),
  }),
  footer: z.string().trim().max(60).optional(),
  buttons: z.array(button).max(10).default([]),
});

/** Cuenta {{n}} y comprueba que sean 1..n consecutivos. */
export function variablesOf(text = '') {
  const found = [...String(text).matchAll(VAR_RE)].map((m) => Number(m[1]));
  const unique = [...new Set(found)].sort((a, b) => a - b);
  const consecutive = unique.every((n, i) => n === i + 1);
  return { count: unique.length, consecutive };
}

const normalizeName = (name) => name.trim().toLowerCase().replace(/[\s-]+/g, '_');

export function buildTemplateComponents(draft) {
  const name = normalizeName(draft.name);
  if (!NAME_RE.test(name)) throw badRequest('El nombre solo admite letras minúsculas, números y guion bajo (p. ej. promo_septiembre)');

  const components = [];

  // Cabecera
  const h = draft.header ?? { type: 'none' };
  if (h.type === 'text') {
    if (!h.text) throw badRequest('Escribe el texto de la cabecera');
    const vars = variablesOf(h.text);
    if (vars.count > 1 || !vars.consecutive) throw badRequest('La cabecera admite como mucho una variable: {{1}}');
    const component = { type: 'HEADER', format: 'TEXT', text: h.text };
    if (vars.count === 1) {
      if (!h.example) throw badRequest('Pon un ejemplo para la variable de la cabecera');
      component.example = { header_text: [h.example] };
    }
    components.push(component);
  } else if (h.type === 'image' || h.type === 'video' || h.type === 'document') {
    if (!h.handle) throw badRequest('Sube un archivo de ejemplo para la cabecera (Meta lo necesita para revisar la plantilla)');
    components.push({ type: 'HEADER', format: h.type.toUpperCase(), example: { header_handle: [h.handle] } });
  }

  // Cuerpo
  const bodyVars = variablesOf(draft.body.text);
  if (!bodyVars.consecutive) throw badRequest('Las variables del cuerpo deben ser {{1}}, {{2}}, {{3}}… en orden y sin saltos');
  const examples = (draft.body.examples ?? []).slice(0, bodyVars.count);
  if (bodyVars.count > 0 && (examples.length < bodyVars.count || examples.some((e) => !e))) {
    throw badRequest(`Escribe un ejemplo para cada variable del cuerpo (${bodyVars.count})`);
  }
  if (/^\s*\{\{\d+\}\}|\{\{\d+\}\}\s*$/.test(draft.body.text)) {
    throw badRequest('Meta no acepta un cuerpo que empiece o termine con una variable; agrega texto antes y después');
  }
  const body = { type: 'BODY', text: draft.body.text };
  if (bodyVars.count > 0) body.example = { body_text: [examples] };
  components.push(body);

  // Pie
  if (draft.footer) components.push({ type: 'FOOTER', text: draft.footer });

  // Botones
  const buttons = draft.buttons ?? [];
  if (buttons.length) {
    const count = (t) => buttons.filter((b) => b.type === t).length;
    if (count('url') > 2) throw badRequest('Máximo 2 botones de enlace (URL)');
    if (count('phone') > 1) throw badRequest('Máximo 1 botón de llamada');
    if (count('copy_code') > 1) throw badRequest('Máximo 1 botón de copiar código');
    // Meta exige que los botones de respuesta rápida vayan agrupados: primero los demás, luego ellos.
    const ordered = [...buttons.filter((b) => b.type !== 'quick_reply'), ...buttons.filter((b) => b.type === 'quick_reply')];
    const out = ordered.map((b) => {
      if (b.type === 'quick_reply') return { type: 'QUICK_REPLY', text: b.text };
      if (b.type === 'phone') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone.replace(/[^\d+]/g, '') };
      if (b.type === 'copy_code') return { type: 'COPY_CODE', example: b.example };
      // URL: si lleva {{1}} al final es dinámica y necesita ejemplo completo.
      const vars = variablesOf(b.url);
      if (vars.count > 1 || !vars.consecutive) throw badRequest('Un enlace admite como mucho una variable {{1}} al final');
      if (vars.count === 1 && !/\{\{\s*1\s*\}\}\s*$/.test(b.url)) throw badRequest('La variable del enlace debe ir al final de la URL');
      if (!/^https?:\/\//i.test(b.url)) throw badRequest('El enlace debe empezar por http:// o https://');
      const component = { type: 'URL', text: b.text, url: b.url };
      if (vars.count === 1) {
        if (!b.example) throw badRequest('Pon un ejemplo completo del enlace (con la variable sustituida)');
        component.example = [b.example];
      }
      return component;
    });
    components.push({ type: 'BUTTONS', buttons: out });
  }

  return {
    name,
    language: draft.language,
    category: draft.category,
    allow_category_change: draft.allowCategoryChange !== false,
    components,
  };
}
