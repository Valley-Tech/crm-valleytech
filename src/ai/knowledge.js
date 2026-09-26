import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import env from '../config/env.js';
import { getObject, deleteObject } from '../storage/index.js';
import {
  createStore,
  uploadToStore,
  deleteDocument,
  describeImage,
  generate,
  fileSearchTool,
  NATIVE_MIME,
  IMAGE_MIME,
  mimeFromName,
} from './gemini.js';
import { crawlSite, fetchPage, htmlToText, titleOf, fetchShopifyProducts, shopifyCatalogMarkdown } from './web.js';

/**
 * Base de conocimiento de cada chatbot y generación de respuestas con Gemini.
 *
 * Flujo: el administrador sube archivos / URLs / FAQ en el CRM → un trabajo
 * de la cola los convierte a texto si hace falta y los sube al almacén de
 * File Search del bot (Gemini los trocea, vectoriza y guarda) → al responder,
 * Gemini busca en ese almacén y cita las fuentes.
 */

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_INLINE_FAQ_CHARS = 9000;

// ---------------------------------------------------------------------------
//  Almacén por bot
// ---------------------------------------------------------------------------

export async function ensureStore(bot) {
  if (bot.fileSearchStore) return bot.fileSearchStore;
  const store = await createStore(`crm-${bot.tenantId.slice(0, 8)}-${bot.name}`.slice(0, 120));
  await prisma.botIntegration.update({ where: { id: bot.id }, data: { fileSearchStore: store.name } });
  logger.info({ botId: bot.id, store: store.name }, 'Almacén de conocimiento creado en Gemini');
  return store.name;
}

// ---------------------------------------------------------------------------
//  Indexación
// ---------------------------------------------------------------------------

function docName(source, suffix = '') {
  return `${source.id}${suffix ? `:${suffix}` : ''}`;
}

async function removeIndexedDocuments(source) {
  const list = Array.isArray(source.documents) ? source.documents : source.documents?.list ?? [];
  const names = [source.documentName, ...list].filter(Boolean);
  for (const name of names) {
    try { await deleteDocument(name); } catch (err) { logger.warn({ name, err: err.message }, 'No se pudo borrar el documento en Gemini'); }
  }
}

async function indexFile(source, store) {
  if (!source.storageKey) throw new Error('El archivo original no está guardado');
  const buffer = await getObject(source.storageKey);
  const mimeType = source.mimeType || mimeFromName(source.name);

  if (IMAGE_MIME.has(mimeType)) {
    // Las imágenes no se indexan tal cual: Gemini las "lee" y se guarda el texto.
    const markdown = await describeImage({ buffer, mimeType, name: source.name });
    const { documentName } = await uploadToStore(store, {
      buffer: Buffer.from(markdown, 'utf8'),
      mimeType: 'text/markdown',
      displayName: docName(source),
      metadata: { kind: 'image', name: source.name },
    });
    return { documentName, extracted: markdown.length };
  }

  if (!NATIVE_MIME.has(mimeType)) {
    throw new Error(`Formato no admitido: ${mimeType}. Usa PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, JSON, HTML, XML o imágenes JPG/PNG.`);
  }
  const { documentName } = await uploadToStore(store, {
    buffer,
    mimeType,
    displayName: docName(source),
    metadata: { kind: 'file', name: source.name },
  });
  return { documentName };
}

async function indexUrl(source, store) {
  const { html, finalUrl } = await fetchPage(source.sourceUrl);
  const text = htmlToText(html);
  if (text.length < 80) throw new Error('La página no tiene texto legible (¿es una app que carga con JavaScript?)');
  const markdown = `# ${titleOf(html, source.sourceUrl)}\n\nURL: ${finalUrl}\n\n${text}`;
  const { documentName } = await uploadToStore(store, {
    buffer: Buffer.from(markdown, 'utf8'),
    mimeType: 'text/markdown',
    displayName: docName(source),
    metadata: { kind: 'url', url: source.sourceUrl },
  });
  return { documentName, pages: 1 };
}

async function indexSite(source, store) {
  const maxPages = Number(source.documents?.maxPages ?? 25);
  const origin = new URL(source.sourceUrl).origin;
  const documents = [];
  let pages = 0;

  // 1) Catálogo Shopify si existe (mucho más preciso que leer las páginas de producto).
  const products = await fetchShopifyProducts(source.sourceUrl).catch(() => null);
  if (products?.length) {
    const markdown = shopifyCatalogMarkdown(products, origin);
    const { documentName } = await uploadToStore(store, {
      buffer: Buffer.from(markdown, 'utf8'),
      mimeType: 'text/markdown',
      displayName: docName(source, 'catalogo'),
      metadata: { kind: 'catalog', url: origin },
    });
    documents.push(documentName);
    pages += 1;
  }

  // 2) Páginas del sitio (inicio, políticas, preguntas frecuentes, sobre nosotros…).
  const crawled = await crawlSite(source.sourceUrl, { maxPages });
  for (const [i, page] of crawled.entries()) {
    const markdown = `# ${page.title}\n\nURL: ${page.url}\n\n${page.text}`;
    try {
      const { documentName } = await uploadToStore(store, {
        buffer: Buffer.from(markdown, 'utf8'),
        mimeType: 'text/markdown',
        displayName: docName(source, `p${i + 1}`),
        metadata: { kind: 'site', url: page.url },
      });
      documents.push(documentName);
      pages += 1;
    } catch (err) {
      logger.warn({ url: page.url, err: err.message }, 'No se pudo indexar una página del sitio');
    }
  }
  if (pages === 0) throw new Error('No se encontró contenido legible en el sitio');
  return { documents: { list: documents, maxPages, catalog: Boolean(products?.length), crawled: crawled.length }, pages };
}

async function indexText(source, store) {
  const [q, a] = String(source.content ?? '').split('\n---\n');
  const markdown = source.kind === 'faq' ? `# Pregunta frecuente\n\n**Pregunta:** ${q}\n\n**Respuesta:** ${a ?? ''}` : `# ${source.name}\n\n${source.content ?? ''}`;
  const { documentName } = await uploadToStore(store, {
    buffer: Buffer.from(markdown, 'utf8'),
    mimeType: 'text/markdown',
    displayName: docName(source),
    metadata: { kind: source.kind, name: source.name },
  });
  return { documentName };
}

/** Trabajo de cola: indexa (o reindexa) una fuente. */
export async function indexSource(sourceId) {
  const source = await prisma.knowledgeSource.findUnique({ where: { id: sourceId }, include: { bot: true } });
  if (!source) return { skipped: 'not_found' };

  await prisma.knowledgeSource.update({ where: { id: source.id }, data: { status: 'processing', error: null } });
  try {
    const store = await ensureStore(source.bot);
    await removeIndexedDocuments(source);

    let result;
    switch (source.kind) {
      case 'file': result = await indexFile(source, store); break;
      case 'url': result = await indexUrl(source, store); break;
      case 'site': result = await indexSite(source, store); break;
      case 'faq':
      case 'text': result = await indexText(source, store); break;
      default: throw new Error(`Tipo de fuente desconocido: ${source.kind}`);
    }

    await prisma.knowledgeSource.update({
      where: { id: source.id },
      data: {
        status: 'ready',
        error: null,
        documentName: result.documentName ?? null,
        documents: result.documents ?? undefined,
        pages: result.pages ?? 1,
        indexedAt: new Date(),
      },
    });
    return { ok: true, pages: result.pages ?? 1 };
  } catch (err) {
    logger.error({ sourceId, err: err.message }, 'Fallo al indexar la fuente de conocimiento');
    await prisma.knowledgeSource.update({ where: { id: source.id }, data: { status: 'error', error: err.message.slice(0, 500) } });
    return { ok: false, error: err.message };
  }
}

export async function removeSource(source) {
  await removeIndexedDocuments(source);
  if (source.storageKey) await deleteObject(source.storageKey);
  await prisma.knowledgeSource.delete({ where: { id: source.id } });
}

// ---------------------------------------------------------------------------
//  Respuesta con IA
// ---------------------------------------------------------------------------

const GUARDRAILS = `
REGLAS DE FORMATO Y CONDUCTA (obligatorias):
- Respondes por WhatsApp: mensajes cortos, claros y cálidos. Máximo {{MAX}} caracteres.
- Negrita solo con un asterisco a cada lado (*así*). Nunca uses ** ni títulos con #.
- Usa la base de conocimiento (documentos, catálogo, preguntas frecuentes) para dar datos concretos: precios, tallas, colores, horarios, políticas. Nunca inventes precios ni disponibilidad; si no está en la información, di que lo confirmas con un asesor.
- No digas "según los documentos" ni "en la información proporcionada": habla como parte del equipo del negocio.
- Si el cliente quiere comprar, reservar o hablar con una persona, indícale el siguiente paso (menú, botón o asesor) sin inventar procesos.
- Responde en el idioma del cliente (normalmente español).
`;

function faqBlock(faqs) {
  if (!faqs.length) return '';
  const lines = ['PREGUNTAS FRECUENTES DEL NEGOCIO:'];
  let total = 0;
  for (const f of faqs) {
    const [q, a] = String(f.content ?? '').split('\n---\n');
    const line = `- P: ${q?.trim()}\n  R: ${a?.trim() ?? ''}`;
    if (total + line.length > MAX_INLINE_FAQ_CHARS) break;
    lines.push(line);
    total += line.length;
  }
  return lines.join('\n');
}

export function buildSystemInstruction(bot, faqs = []) {
  const parts = [
    bot.aiInstructions?.trim() || `Eres el asistente virtual de ${bot.name}. Atiendes clientes por WhatsApp con amabilidad y precisión.`,
    GUARDRAILS.replace('{{MAX}}', String(bot.aiMaxChars ?? 600)),
    faqBlock(faqs),
  ];
  return parts.filter(Boolean).join('\n\n');
}

/** Pasa el Markdown de Gemini al formato que WhatsApp sí entiende. */
export function toWhatsAppText(text = '', maxChars = 600) {
  let s = String(text)
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const limit = Math.round(maxChars * 1.3);
  if (s.length > limit) {
    const cut = s.slice(0, limit);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    s = (end > limit * 0.5 ? cut.slice(0, end + 1) : cut).trim();
  }
  return s;
}

/** Convierte mensajes del CRM en historial para Gemini (solo texto, roles alternados). */
export function historyFromMessages(messages = [], limit = 20) {
  const items = messages
    .filter((m) => m.text && m.text.trim())
    .slice(-limit)
    .map((m) => ({ role: m.direction === 'inbound' ? 'user' : 'model', text: m.text.trim() }));
  const merged = [];
  for (const it of items) {
    const last = merged[merged.length - 1];
    if (last && last.role === it.role) last.text += `\n${it.text}`;
    else merged.push({ ...it });
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  return merged.map((m) => ({ role: m.role, parts: [{ text: m.text.slice(0, 4000) }] }));
}

/**
 * Genera la respuesta de la IA de un bot.
 * history: [{ role: 'user'|'model', parts:[{text}] }] (opcional).
 */
export async function answer({ bot, text, history = [] }) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no está configurada en el CRM');

  const [faqs, readyDocs] = await Promise.all([
    prisma.knowledgeSource.findMany({ where: { botId: bot.id, kind: 'faq', status: 'ready' }, orderBy: { createdAt: 'asc' } }),
    prisma.knowledgeSource.count({ where: { botId: bot.id, status: 'ready', kind: { in: ['file', 'url', 'site', 'text'] } } }),
  ]);

  const tools = readyDocs > 0 && bot.fileSearchStore ? fileSearchTool(bot.fileSearchStore) : [];
  const contents = [...history, { role: 'user', parts: [{ text: String(text).slice(0, 4000) }] }];

  const started = Date.now();
  const result = await generate({
    model: bot.aiModel || env.GEMINI_MODEL,
    systemInstruction: buildSystemInstruction(bot, faqs),
    contents,
    tools,
    generationConfig: { temperature: bot.aiTemperature ?? 0.4, maxOutputTokens: 1024 },
  });

  const clean = toWhatsAppText(result.text, bot.aiMaxChars ?? 600) || 'Disculpa, no pude generar una respuesta en este momento. ¿Me lo repites de otra forma?';
  return {
    text: clean,
    model: result.model,
    sources: result.sources,
    usedKnowledge: tools.length > 0,
    ms: Date.now() - started,
  };
}

/** Historial reciente de una conversación del CRM en formato Gemini. */
export async function conversationHistory(conversationId, limit = 20) {
  const messages = await prisma.message.findMany({
    where: { conversationId, type: 'text' },
    orderBy: { createdAt: 'desc' },
    take: limit * 2,
    select: { direction: true, text: true },
  });
  return historyFromMessages(messages.reverse(), limit);
}
