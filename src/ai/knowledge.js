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
import { generate as claudeGenerate, pdfBlock, imageBlock, textDocumentBlock, CACHE_1H, CLAUDE_MODELS } from './claude.js';

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
/** Texto extraído que se guarda por fuente (para Claude, que recibe el conocimiento en contexto). */
export const MAX_EXTRACTED_CHARS = 300_000;
/** Presupuesto total de conocimiento en contexto para Claude (≈ 60–70 k tokens) y de PDF en bytes. */
export const CLAUDE_TEXT_BUDGET = 240_000;
export const CLAUDE_PDF_BUDGET = 8 * 1024 * 1024;
const TEXT_MIME = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'text/html', 'application/xml', 'text/xml']);
const CLAUDE_ONLY_GEMINI_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
export const AI_PROVIDERS = ['gemini', 'claude'];

// ---------------------------------------------------------------------------
//  Almacén por bot
// ---------------------------------------------------------------------------

export async function ensureStore(bot) {
  // Sin clave de Gemini no hay File Search: se indexa solo el texto local (sirve para Claude).
  if (!env.GEMINI_API_KEY) return null;
  if (bot.fileSearchStore) return bot.fileSearchStore;
  const store = await createStore(`crm-${bot.tenantId.slice(0, 8)}-${bot.name}`.slice(0, 120));
  await prisma.botIntegration.update({ where: { id: bot.id }, data: { fileSearchStore: store.name } });
  logger.info({ botId: bot.id, store: store.name }, 'Almacén de conocimiento creado en Gemini');
  return store.name;
}

// ---------------------------------------------------------------------------
//  Indexación
// ---------------------------------------------------------------------------

/** Sube al almacén de Gemini si existe; si no (sin GEMINI_API_KEY), no hace nada. */
async function maybeUpload(store, payload) {
  if (!store) return { documentName: null };
  return uploadToStore(store, payload);
}

function docName(source, suffix = '') {
  return `${source.id}${suffix ? `:${suffix}` : ''}`;
}

async function removeIndexedDocuments(source) {
  if (!env.GEMINI_API_KEY) return;
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
    // Sin Gemini, Claude las recibe tal cual (bloque de imagen).
    if (!env.GEMINI_API_KEY) return { documentName: null, extractedText: null };
    const markdown = await describeImage({ buffer, mimeType, name: source.name });
    const { documentName } = await maybeUpload(store, {
      buffer: Buffer.from(markdown, 'utf8'),
      mimeType: 'text/markdown',
      displayName: docName(source),
      metadata: { kind: 'image', name: source.name },
    });
    return { documentName, extractedText: markdown };
  }

  if (!NATIVE_MIME.has(mimeType)) {
    throw new Error(`Formato no admitido: ${mimeType}. Usa PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, JSON, HTML, XML o imágenes JPG/PNG.`);
  }
  const { documentName } = await maybeUpload(store, {
    buffer,
    mimeType,
    displayName: docName(source),
    metadata: { kind: 'file', name: source.name },
  });
  // Archivos de texto: se guarda el contenido para el proveedor sin File Search (Claude).
  const extractedText = TEXT_MIME.has(mimeType)
    ? (mimeType === 'text/html' ? htmlToText(buffer.toString('utf8')) : buffer.toString('utf8')).slice(0, MAX_EXTRACTED_CHARS)
    : null;
  return { documentName, extractedText };
}

async function indexUrl(source, store) {
  const { html, finalUrl } = await fetchPage(source.sourceUrl);
  const text = htmlToText(html);
  if (text.length < 80) throw new Error('La página no tiene texto legible (¿es una app que carga con JavaScript?)');
  const markdown = `# ${titleOf(html, source.sourceUrl)}\n\nURL: ${finalUrl}\n\n${text}`;
  const { documentName } = await maybeUpload(store, {
    buffer: Buffer.from(markdown, 'utf8'),
    mimeType: 'text/markdown',
    displayName: docName(source),
    metadata: { kind: 'url', url: source.sourceUrl },
  });
  return { documentName, pages: 1, extractedText: markdown };
}

async function indexSite(source, store) {
  const maxPages = Number(source.documents?.maxPages ?? 25);
  const origin = new URL(source.sourceUrl).origin;
  const documents = [];
  const texts = [];
  let pages = 0;

  // 1) Catálogo Shopify si existe (mucho más preciso que leer las páginas de producto).
  const products = await fetchShopifyProducts(source.sourceUrl).catch(() => null);
  if (products?.length) {
    const markdown = shopifyCatalogMarkdown(products, origin);
    texts.push(markdown);
    const { documentName } = await maybeUpload(store, {
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
    texts.push(markdown);
    try {
      const { documentName } = await maybeUpload(store, {
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
  return {
    documents: { list: documents, maxPages, catalog: Boolean(products?.length), crawled: crawled.length },
    pages,
    extractedText: texts.join('\n\n---\n\n').slice(0, MAX_EXTRACTED_CHARS),
  };
}

async function indexText(source, store) {
  const [q, a] = String(source.content ?? '').split('\n---\n');
  const markdown = source.kind === 'faq' ? `# Pregunta frecuente\n\n**Pregunta:** ${q}\n\n**Respuesta:** ${a ?? ''}` : `# ${source.name}\n\n${source.content ?? ''}`;
  const { documentName } = await maybeUpload(store, {
    buffer: Buffer.from(markdown, 'utf8'),
    mimeType: 'text/markdown',
    displayName: docName(source),
    metadata: { kind: source.kind, name: source.name },
  });
  return { documentName, extractedText: markdown };
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
        extractedText: result.extractedText ?? null,
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

const KNOWLEDGE_KINDS = ['file', 'url', 'site', 'text', 'faq'];

/**
 * ¿Puede responder la IA de este bot? Solo si está activa, tiene al menos una
 * fuente de conocimiento indexada y el proveedor elegido tiene clave en el CRM.
 * Los bots sin IA siguen con sus menús, plantillas y flujos de siempre.
 */
export async function aiReadiness(bot) {
  const provider = AI_PROVIDERS.includes(bot.aiProvider) ? bot.aiProvider : 'gemini';
  const readySources = await prisma.knowledgeSource.count({ where: { botId: bot.id, status: 'ready', kind: { in: KNOWLEDGE_KINDS } } });
  const configured = provider === 'claude' ? Boolean(env.ANTHROPIC_API_KEY) : Boolean(env.GEMINI_API_KEY);
  let reason = null;
  if (!configured) reason = provider === 'claude' ? 'ai_not_configured' : 'ai_not_configured';
  else if (readySources === 0) reason = 'ai_no_knowledge';
  else if (!bot.aiEnabled) reason = 'ai_disabled';
  return { provider, enabled: Boolean(bot.aiEnabled), readySources, configured, ready: reason === null, reason };
}

export const READINESS_MESSAGES = {
  ai_disabled: 'La IA de este chatbot está desactivada en el CRM (Chatbots → IA y conocimiento).',
  ai_no_knowledge: 'Este chatbot no tiene ninguna fuente de conocimiento lista (archivo, sitio web, texto o pregunta frecuente). Agrega una e indexa antes de usar la IA.',
  ai_not_configured: 'El CRM no tiene la clave del proveedor de IA configurada (GEMINI_API_KEY o ANTHROPIC_API_KEY).',
};

/**
 * Genera la respuesta de la IA de un bot con el proveedor elegido.
 * history: [{ role: 'user'|'model', parts:[{text}] }] (opcional).
 */
export async function answer({ bot, text, history = [] }) {
  const provider = AI_PROVIDERS.includes(bot.aiProvider) ? bot.aiProvider : 'gemini';
  return provider === 'claude' ? answerWithClaude({ bot, text, history }) : answerWithGemini({ bot, text, history });
}

async function answerWithGemini({ bot, text, history = [] }) {
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
    // Sin maxOutputTokens bajo: en modelos con razonamiento el "pensamiento" también
    // consume ese tope y la respuesta salía cortada a mitad de frase.
    generationConfig: { temperature: bot.aiTemperature ?? 0.4 },
  });

  const clean = toWhatsAppText(result.text, bot.aiMaxChars ?? 600) || 'Disculpa, no pude generar una respuesta en este momento. ¿Me lo repites de otra forma?';
  return {
    text: clean,
    provider: 'gemini',
    model: result.model,
    sources: result.sources,
    usedKnowledge: tools.length > 0,
    finishReason: result.finishReason ?? null,
    usage: result.usage ?? null,
    ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
//  Claude: conocimiento en contexto con caché de prompt
// ---------------------------------------------------------------------------

/**
 * Arma el conocimiento del bot como bloques para Claude:
 *  - texto (FAQ, textos, sitios rastreados, catálogo, archivos de texto, imágenes transcritas) → un bloque cacheado;
 *  - PDF e imágenes → bloques de documento/imagen (nativos de Claude) dentro del primer turno, también cacheados.
 * Word/Excel/PowerPoint solo los entiende Gemini: se omiten y se avisa en `skipped`.
 */
export async function buildClaudeKnowledge(bot) {
  const sources = await prisma.knowledgeSource.findMany({
    where: { botId: bot.id, status: 'ready', kind: { in: KNOWLEDGE_KINDS } },
    orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
  });

  const chunks = [];
  const blocks = [];
  const skipped = [];
  let textBudget = CLAUDE_TEXT_BUDGET;
  let pdfBudget = CLAUDE_PDF_BUDGET;

  const pushText = (title, body) => {
    if (!body || textBudget <= 0) return;
    const piece = `### ${title}\n${body}`.slice(0, textBudget);
    chunks.push(piece);
    textBudget -= piece.length;
  };

  // Primero lo más "denso": FAQ y textos; luego sitios; al final archivos.
  const order = { faq: 0, text: 1, site: 2, url: 3, file: 4 };
  for (const source of [...sources].sort((a, b) => order[a.kind] - order[b.kind])) {
    if (source.kind === 'faq') {
      const [q, a] = String(source.content ?? '').split('\n---\n');
      pushText(`Pregunta frecuente: ${q?.trim()}`, a?.trim() ?? '');
      continue;
    }
    if (source.kind !== 'file') {
      pushText(source.name, source.extractedText ?? source.content ?? '');
      continue;
    }
    const mimeType = source.mimeType || mimeFromName(source.name);
    if (source.extractedText) {
      pushText(source.name, source.extractedText);
      continue;
    }
    if (CLAUDE_ONLY_GEMINI_MIME.has(mimeType)) {
      skipped.push(source.name);
      continue;
    }
    if (!source.storageKey) continue;
    try {
      const buffer = await getObject(source.storageKey);
      if (mimeType === 'application/pdf') {
        if (buffer.length > pdfBudget) { skipped.push(`${source.name} (supera el límite de PDF para Claude)`); continue; }
        pdfBudget -= buffer.length;
        blocks.push(pdfBlock(buffer, source.name));
      } else if (IMAGE_MIME.has(mimeType) && buffer.length <= 5 * 1024 * 1024) {
        blocks.push(imageBlock(buffer, mimeType));
      } else {
        skipped.push(source.name);
      }
    } catch (err) {
      logger.warn({ sourceId: source.id, err: err.message }, 'No se pudo cargar un archivo para Claude');
      skipped.push(source.name);
    }
  }

  return { text: chunks.join('\n\n'), blocks, skipped, sources: sources.length };
}

async function answerWithClaude({ bot, text, history = [] }) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no está configurada en el CRM');

  const knowledge = await buildClaudeKnowledge(bot);
  const started = Date.now();

  // Sistema: instrucciones (varían poco) + conocimiento (grande, cacheado 1 h).
  const system = [
    { type: 'text', text: buildSystemInstruction(bot, []) },
  ];
  if (knowledge.text) {
    system.push({ type: 'text', text: `BASE DE CONOCIMIENTO DEL NEGOCIO (úsala como única fuente de datos concretos):\n\n${knowledge.text}`, cache_control: CACHE_1H });
  }

  const messages = [];
  if (knowledge.blocks.length) {
    const content = [...knowledge.blocks, { type: 'text', text: 'Estos son los documentos de referencia del negocio. Úsalos para responder a los clientes.' }];
    content[content.length - 1].cache_control = CACHE_1H;
    messages.push({ role: 'user', content });
    messages.push({ role: 'assistant', content: 'Entendido, usaré estos documentos para responder.' });
  }
  for (const turn of history) {
    const t = (turn.parts ?? []).map((p) => p.text).join('\n').trim();
    if (!t) continue;
    const role = turn.role === 'model' ? 'assistant' : 'user';
    const last = messages[messages.length - 1];
    if (last && last.role === role && typeof last.content === 'string') last.content += `\n${t}`;
    else messages.push({ role, content: t });
  }
  const current = String(text).slice(0, 4000);
  const last = messages[messages.length - 1];
  if (last && last.role === 'user' && typeof last.content === 'string') last.content += `\n${current}`;
  else messages.push({ role: 'user', content: current });

  const result = await claudeGenerate({
    model: bot.aiModel && bot.aiModel.startsWith('claude') ? bot.aiModel : env.CLAUDE_MODEL,
    system,
    messages,
    temperature: bot.aiTemperature ?? 0.4,
    maxTokens: 2048,
  });

  const clean = toWhatsAppText(result.text, bot.aiMaxChars ?? 600) || 'Disculpa, no pude generar una respuesta en este momento. ¿Me lo repites de otra forma?';
  return {
    text: clean,
    provider: 'claude',
    model: result.model,
    sources: [],
    usedKnowledge: Boolean(knowledge.text || knowledge.blocks.length),
    skipped: knowledge.skipped,
    usage: result.usage,
    ms: Date.now() - started,
  };
}

export { CLAUDE_MODELS };

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
