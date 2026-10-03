import env from '../config/env.js';
import logger from '../lib/logger.js';
import { generate as geminiGenerate } from './gemini.js';
import { generate as claudeGenerate, CACHE_1H } from './claude.js';

/**
 * Catálogo de productos para búsqueda por IA (MerkCentro24 y similares).
 *
 * El negocio carga su lista "id → nombre (precio, categoría)" en Chatbots → IA y
 * conocimiento → Catálogo de productos. Cuando el cliente escribe "quiero una
 * gaseosa postobón", el bot pide al CRM los productos que coinciden y recibe
 * los IDs **reales** de la lista (nunca inventados) para enviar el producto del
 * catálogo de WhatsApp (product_retailer_id) o armar el pedido.
 *
 * Esto sustituye al diccionario `product_names` que vivía quemado en el
 * geminiService.js del bot: ahora se edita en el CRM sin desplegar.
 */

export const MAX_PRODUCTS = 5000;
/** Si la preselección por palabras deja hasta tantos candidatos, solo se mandan esos a la IA. */
const SHORTLIST_MAX = 80;
/** Productos que caben en el prompt cuando hay que mandar la lista completa. */
const FULL_LIST_MAX = 3000;

// ---------------------------------------------------------------------------
//  Lectura de la lista (CSV, JSON, texto "id | nombre", diccionario JS…)
// ---------------------------------------------------------------------------

const HEADERS = {
  id: ['id', 'codigo', 'código', 'sku', 'product_id', 'retailer_id', 'product_retailer_id', 'id_producto', 'idproducto', 'ref', 'referencia'],
  name: ['nombre', 'name', 'producto', 'product', 'title', 'titulo', 'título', 'descripcion', 'descripción', 'description'],
  price: ['precio', 'price', 'valor', 'amount'],
  category: ['categoria', 'categoría', 'category', 'grupo', 'seccion', 'sección', 'linea', 'línea'],
};

const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

function headerIndex(cols, keys) {
  const lower = cols.map((c) => clean(c).toLowerCase().replace(/^﻿/, ''));
  return keys.map((k) => lower.indexOf(k)).find((i) => i >= 0) ?? -1;
}

/** Divide una línea CSV respetando comillas. */
function splitCsv(line, sep) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function detectSeparator(lines) {
  const sample = lines.slice(0, 20);
  const score = (sep) => sample.reduce((n, l) => n + (l.split(sep).length - 1), 0);
  return [['\t', score('\t')], [';', score(';')], ['|', score('|')], [',', score(',')]].sort((a, b) => b[1] - a[1])[0][0];
}

function fromObjects(items) {
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const get = (keys) => { const k = Object.keys(it).find((x) => keys.includes(x.toLowerCase())); return k ? it[k] : undefined; };
    const id = clean(get(HEADERS.id) ?? it.id);
    const name = clean(get(HEADERS.name) ?? it.name);
    if (!id || !name) continue;
    out.push({ id, name, price: numberOrNull(get(HEADERS.price)), category: clean(get(HEADERS.category)) || null });
  }
  return out;
}

function numberOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Convierte lo pegado o subido en [{ id, name, price, category }].
 * Acepta: JSON (array de objetos o {id: nombre}), CSV/TSV con cabecera (id, nombre,
 * precio, categoría), líneas "id | nombre | precio", "id;nombre", "id,nombre", y el
 * diccionario JS antiguo ("id": "nombre",). Los IDs repetidos se quedan con el último.
 */
export function parseProducts(input) {
  const text = String(input ?? '').replace(/^﻿/, '').trim();
  if (!text) return [];
  let rows = [];

  // JSON
  if (/^[[{]/.test(text)) {
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) rows = fromObjects(data);
      else if (data && typeof data === 'object') {
        const items = Array.isArray(data.products) || Array.isArray(data.items) ? (data.products ?? data.items) : null;
        rows = items ? fromObjects(items) : Object.entries(data).map(([id, v]) => (typeof v === 'string' ? { id, name: v, price: null, category: null } : { id, ...fromObjects([{ ...v, id }])[0] })).filter((r) => r.name);
      }
    } catch { /* no era JSON válido: se intenta como texto */ }
  }

  // Diccionario JS: "id": "nombre",  /  'id': 'nombre'
  if (!rows.length) {
    const re = /["']([^"'\n]{1,120})["']\s*:\s*["']([^"'\n]{1,200})["']/g;
    let m;
    while ((m = re.exec(text))) rows.push({ id: clean(m[1]), name: clean(m[2]), price: null, category: null });
    if (rows.length && rows.length < text.split('\n').length / 3) rows = []; // casi nada coincidió: no era un diccionario
  }

  // CSV / TSV / líneas separadas
  if (!rows.length) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));
    const sep = detectSeparator(lines);
    const first = splitCsv(lines[0], sep);
    let idIdx = headerIndex(first, HEADERS.id);
    let nameIdx = headerIndex(first, HEADERS.name);
    let priceIdx = headerIndex(first, HEADERS.price);
    let catIdx = headerIndex(first, HEADERS.category);
    const hasHeader = idIdx >= 0 || nameIdx >= 0;
    if (!hasHeader) { idIdx = 0; nameIdx = 1; priceIdx = 2; catIdx = 3; }
    if (idIdx < 0) idIdx = nameIdx === 0 ? 1 : 0;
    if (nameIdx < 0) nameIdx = idIdx === 0 ? 1 : 0;
    for (const line of hasHeader ? lines.slice(1) : lines) {
      const cols = splitCsv(line, sep);
      const id = clean(cols[idIdx]);
      const name = clean(cols[nameIdx]);
      if (!id || !name) continue;
      rows.push({ id, name, price: priceIdx >= 0 ? numberOrNull(cols[priceIdx]) : null, category: catIdx >= 0 ? clean(cols[catIdx]) || null : null });
    }
  }

  const byId = new Map();
  for (const r of rows) {
    if (!r.id || !r.name) continue;
    byId.set(r.id.slice(0, 120), { id: r.id.slice(0, 120), name: r.name.slice(0, 200), price: r.price ?? null, category: r.category ?? null });
  }
  return [...byId.values()].slice(0, MAX_PRODUCTS);
}

/** Markdown para indexar el catálogo también como conocimiento (preguntas libres). */
export function productsMarkdown(products, title = 'Catálogo de productos') {
  const lines = [`# ${title}`, '', 'Productos disponibles (nombre · precio · categoría):', ''];
  for (const p of products) {
    lines.push(`- ${p.name}${p.price != null ? ` · $${formatPrice(p.price)}` : ''}${p.category ? ` · ${p.category}` : ''}`);
  }
  return lines.join('\n');
}

export const formatPrice = (n) => Number(n).toLocaleString('es-CO', { maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------
//  Búsqueda
// ---------------------------------------------------------------------------

export const normalize = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9ñ ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const STOP = new Set(['quiero', 'quisiera', 'necesito', 'busco', 'dame', 'deme', 'me', 'una', 'uno', 'unos', 'unas', 'un', 'el', 'la', 'los', 'las', 'de', 'del', 'por', 'favor', 'porfa', 'para', 'con', 'sin', 'que', 'tienen', 'tiene', 'hay', 'venden', 'vende', 'algo', 'y', 'o', 'a', 'en', 'mi', 'tu', 'su', 'pedir', 'comprar', 'precio', 'cuanto', 'cuesta', 'vale', 'hola', 'buenas', 'buenos', 'dias', 'tardes', 'noches']);

const stem = (w) => w.replace(/(es|s)$/i, '');

/** Palabras útiles de la consulta (sin muletillas), con raíz simple para plurales. */
export function queryTerms(text) {
  return [...new Set(normalize(text).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)).map(stem))];
}

/** Puntúa productos por coincidencia de palabras (prefijo, insensible a tildes). */
export function shortlist(products, text, max = SHORTLIST_MAX) {
  const terms = queryTerms(text);
  if (!terms.length) return [];
  const scored = [];
  for (const p of products) {
    const words = normalize(`${p.name} ${p.category ?? ''}`).split(' ').map(stem);
    let score = 0;
    for (const t of terms) {
      if (words.some((w) => w === t)) score += 3;
      else if (words.some((w) => w.startsWith(t) || (t.length >= 5 && w.includes(t)))) score += 2;
    }
    if (score > 0) scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name, 'es'));
  return scored.slice(0, max).map((s) => s.p);
}

function listForPrompt(products) {
  return products.map((p) => `${p.id} | ${p.name}${p.price != null ? ` | $${formatPrice(p.price)}` : ''}${p.category ? ` | ${p.category}` : ''}`).join('\n');
}

const SYSTEM = `Eres el buscador de productos de un negocio. Recibes la lista de productos (una línea por producto: ID | nombre | precio | categoría) y lo que escribió un cliente por WhatsApp.

Devuelve ÚNICAMENTE un JSON con esta forma, sin texto adicional:
{"matches":[{"id":"<ID exacto de la lista>","name":"<nombre exacto de la lista>"}],"none":false}

Reglas:
- Incluye todos los productos de la lista que correspondan a lo que pide el cliente (marca, sabor, presentación, tamaño, sinónimos y plurales). Si pide algo genérico ("una gaseosa", "jabón"), incluye las opciones que haya, hasta {{MAX}}.
- Si el cliente nombra varios productos, incluye los de todos.
- Copia el ID y el nombre EXACTAMENTE como aparecen en la lista. Nunca inventes productos ni IDs.
- Si nada corresponde, responde {"matches":[],"none":true}.
- Ordena primero el más parecido a lo que pidió.`;

/**
 * Busca productos para una frase del cliente.
 * Devuelve { items: [{id, name, price, category}], none, provider, model, candidates, ms }.
 */
export async function searchProducts({ bot, products, text, limit = 10 }) {
  if (!products?.length) return { items: [], none: true, provider: null, model: null, candidates: 0, ms: 0 };
  const started = Date.now();
  const byId = new Map(products.map((p) => [p.id, p]));
  const byName = new Map(products.map((p) => [normalize(p.name), p]));

  // 1) Preselección por palabras: si deja pocos candidatos, la IA solo ve esos (más barato y preciso).
  const pre = shortlist(products, text);
  const candidates = pre.length > 0 && pre.length <= SHORTLIST_MAX ? pre : products.slice(0, FULL_LIST_MAX);

  // 2) La IA elige entre los candidatos y devuelve IDs reales.
  const provider = bot.aiProvider === 'claude' ? 'claude' : 'gemini';
  const system = SYSTEM.replace('{{MAX}}', String(limit));
  const prompt = `LISTA DE PRODUCTOS:\n${listForPrompt(candidates)}\n\nMENSAJE DEL CLIENTE: ${String(text).slice(0, 500)}`;
  let raw = '';
  let model = null;
  try {
    if (provider === 'claude') {
      const r = await claudeGenerate({
        model: bot.aiModel && bot.aiModel.startsWith('claude') ? bot.aiModel : env.CLAUDE_MODEL,
        system: [{ type: 'text', text: system, cache_control: CACHE_1H }],
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        maxTokens: 1024,
      });
      raw = r.text; model = r.model;
    } else {
      const r = await geminiGenerate({
        model: bot.aiModel && !bot.aiModel.startsWith('claude') ? bot.aiModel : env.GEMINI_MODEL,
        systemInstruction: system,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      });
      raw = r.text; model = r.model;
    }
  } catch (err) {
    // Si la IA falla, la preselección por palabras sigue sirviendo.
    logger.warn({ botId: bot.id, err: err.message }, 'Búsqueda de productos: la IA falló, se usa la preselección');
    const items = pre.slice(0, limit);
    return { items, none: items.length === 0, provider, model: null, candidates: candidates.length, fallback: true, ms: Date.now() - started };
  }

  // 3) Solo se aceptan IDs (o nombres exactos) que existan en la lista.
  const parsed = parseMatches(raw);
  const items = [];
  const seen = new Set();
  for (const m of parsed) {
    const p = byId.get(clean(m.id)) ?? byName.get(normalize(m.name));
    if (p && !seen.has(p.id)) { seen.add(p.id); items.push(p); }
    if (items.length >= limit) break;
  }
  return { items, none: items.length === 0, provider, model, candidates: candidates.length, ms: Date.now() - started };
}

function parseMatches(raw) {
  const text = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : data?.matches;
    return Array.isArray(list) ? list.filter((m) => m && typeof m === 'object') : [];
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { const data = JSON.parse(text.slice(start, end + 1)); return Array.isArray(data?.matches) ? data.matches : []; } catch { /* nada */ }
    }
    return [];
  }
}

/** Texto listo para WhatsApp con los productos encontrados. */
export function productsText(items, { none = false } = {}) {
  if (none || !items.length) return 'Lo siento, no encontré ningún producto relacionado con tu búsqueda. Por favor, intenta con otra palabra clave.';
  return items.map((p) => `• ${p.name}${p.price != null ? ` · $${formatPrice(p.price)}` : ''}`).join('\n');
}
