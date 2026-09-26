import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import env from '../../config/env.js';
import { asyncHandler } from '../../lib/http.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAudit } from '../../services/audit.js';
import { putObject } from '../../storage/index.js';
import { knowledgeQueue } from '../../queues/index.js';
import { MAX_FILE_BYTES, removeSource, answer, historyFromMessages } from '../../ai/knowledge.js';
import { NATIVE_MIME, IMAGE_MIME, MODEL_FALLBACKS, mimeFromName } from '../../ai/gemini.js';

/**
 * "IA y conocimiento" de cada chatbot: instrucciones, preguntas frecuentes,
 * archivos y sitios web que la IA usa para responder (como el Meta Business
 * Agent, pero con tu propia clave de Gemini y para cualquier bot).
 */

const router = Router();
router.use(requireAuth, requireRole('admin'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 10 } });

function serializeSource(s) {
  const list = Array.isArray(s.documents) ? s.documents : s.documents?.list ?? [];
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    status: s.status,
    error: s.error,
    mimeType: s.mimeType,
    sizeBytes: s.sizeBytes,
    sourceUrl: s.sourceUrl,
    content: s.kind === 'faq' || s.kind === 'text' ? s.content : undefined,
    pages: s.pages,
    documents: list.length,
    catalog: Boolean(s.documents?.catalog),
    indexedAt: s.indexedAt,
    createdAt: s.createdAt,
  };
}

function serializeAi(bot) {
  return {
    aiEnabled: bot.aiEnabled,
    aiModel: bot.aiModel,
    aiInstructions: bot.aiInstructions ?? '',
    aiTemperature: bot.aiTemperature,
    aiMaxChars: bot.aiMaxChars,
    fileSearchStore: bot.fileSearchStore,
    geminiConfigured: Boolean(env.GEMINI_API_KEY),
    defaultModel: env.GEMINI_MODEL,
    models: [...new Set([env.GEMINI_MODEL, ...MODEL_FALLBACKS])],
  };
}

async function loadBot(req) {
  const bot = await prisma.botIntegration.findFirst({ where: { id: req.params.id, tenantId: req.auth.tenantId } });
  if (!bot) throw notFound('Chatbot no encontrado');
  return bot;
}

async function enqueue(sourceId) {
  await knowledgeQueue.add('index', { sourceId }, { jobId: `kb-${sourceId}-${Date.now()}` });
}

// ---------------------------------------------------------------------------
router.get(
  '/bots/:id/ai',
  asyncHandler(async (req, res) => {
    const bot = await loadBot(req);
    const sources = await prisma.knowledgeSource.findMany({ where: { botId: bot.id }, orderBy: { createdAt: 'desc' } });
    res.json({ ...serializeAi(bot), sources: sources.map(serializeSource) });
  })
);

router.patch(
  '/bots/:id/ai',
  asyncHandler(async (req, res) => {
    const bot = await loadBot(req);
    const data = z
      .object({
        aiEnabled: z.boolean().optional(),
        aiModel: z.string().max(80).nullable().optional(),
        aiInstructions: z.string().max(20000).optional(),
        aiTemperature: z.number().min(0).max(1).optional(),
        aiMaxChars: z.number().int().min(120).max(3000).optional(),
      })
      .parse(req.body);
    const updated = await prisma.botIntegration.update({ where: { id: bot.id }, data });
    await recordAudit({ tenantId: req.auth.tenantId, actorUserId: req.auth.userId, action: 'bot.ai.update', entity: 'bot', entityId: bot.id, metadata: Object.keys(data) });
    res.json(serializeAi(updated));
  })
);

// ---------------------------------------------------------------------------
//  Fuentes
// ---------------------------------------------------------------------------

/** Archivos: pdf, docx, xlsx, pptx, txt, md, csv, json, html, xml, jpg, png… (varios a la vez). */
router.post(
  '/bots/:id/knowledge/files',
  upload.array('files', 10),
  asyncHandler(async (req, res) => {
    const bot = await loadBot(req);
    if (!req.files?.length) throw badRequest('Adjunta al menos un archivo en el campo "files"');

    const created = [];
    for (const file of req.files) {
      const mimeType = file.mimetype && file.mimetype !== 'application/octet-stream' ? file.mimetype : mimeFromName(file.originalname);
      if (!NATIVE_MIME.has(mimeType) && !IMAGE_MIME.has(mimeType)) {
        throw badRequest(`"${file.originalname}": formato no admitido (${mimeType}). Usa PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, JSON, HTML, XML, JPG o PNG.`);
      }
      const source = await prisma.knowledgeSource.create({
        data: { tenantId: req.auth.tenantId, botId: bot.id, kind: 'file', name: file.originalname, mimeType, sizeBytes: file.size },
      });
      const ext = file.originalname.includes('.') ? `.${file.originalname.split('.').pop()}` : '';
      const key = `${req.auth.tenantId}/knowledge/${source.id}${ext}`;
      await putObject(key, file.buffer, mimeType);
      const withKey = await prisma.knowledgeSource.update({ where: { id: source.id }, data: { storageKey: key } });
      await enqueue(source.id);
      created.push(serializeSource(withKey));
    }
    await recordAudit({ tenantId: req.auth.tenantId, actorUserId: req.auth.userId, action: 'bot.knowledge.add', entity: 'bot', entityId: bot.id, metadata: { files: created.map((c) => c.name) } });
    res.status(201).json({ items: created });
  })
);

/** Sitio web (rastreo) o una sola página. */
router.post(
  '/bots/:id/knowledge/url',
  asyncHandler(async (req, res) => {
    const bot = await loadBot(req);
    const input = z
      .object({
        url: z.string().url(),
        crawl: z.boolean().default(true),
        maxPages: z.number().int().min(1).max(100).default(25),
        name: z.string().max(160).optional(),
      })
      .parse(req.body);
    if (!/^https?:/.test(input.url)) throw badRequest('La URL debe empezar por http:// o https://');

    const source = await prisma.knowledgeSource.create({
      data: {
        tenantId: req.auth.tenantId,
        botId: bot.id,
        kind: input.crawl ? 'site' : 'url',
        name: input.name || new URL(input.url).host + (input.crawl ? ' (sitio completo)' : new URL(input.url).pathname),
        sourceUrl: input.url,
        documents: input.crawl ? { maxPages: input.maxPages, list: [] } : undefined,
      },
    });
    await enqueue(source.id);
    res.status(201).json(serializeSource(source));
  })
);

/** Pregunta frecuente. */
router.post(
  '/bots/:id/knowledge/faq',
  asyncHandler(async (req, res) => {
    const bot = await loadBot(req);
    const input = z.object({ question: z.string().trim().min(3).max(500), answer: z.string().trim().min(1).max(4000) }).parse(req.body);
    const source = await prisma.knowledgeSource.create({
      data: { tenantId: req.auth.tenantId, botId: bot.id, kind: 'faq', name: input.question.slice(0, 160), content: `${input.question}\n---\n${input.answer}` },
    });
    await enqueue(source.id);
    res.status(201).json(serializeSource(source));
  })
);

/** Texto libre (política de envíos, horarios, descripción del negocio…). */
router.post(
  '/bots/:id/knowledge/text',
  asyncHandler(async (req, res) => {
    const bot = await loadBot(req);
    const input = z.object({ name: z.string().trim().min(2).max(160), content: z.string().trim().min(10).max(60000) }).parse(req.body);
    const source = await prisma.knowledgeSource.create({
      data: { tenantId: req.auth.tenantId, botId: bot.id, kind: 'text', name: input.name, content: input.content },
    });
    await enqueue(source.id);
    res.status(201).json(serializeSource(source));
  })
);

router.patch(
  '/bots/:id/knowledge/:sourceId',
  asyncHandler(async (req, res) => {
    const bot = await loadBot(req);
    const source = await prisma.knowledgeSource.findFirst({ where: { id: req.params.sourceId, botId: bot.id } });
    if (!source) throw notFound('Fuente no encontrada');
    const input = z.object({ name: z.string().trim().max(160).optional(), question: z.string().trim().max(500).optional(), answer: z.string().trim().max(4000).optional(), content: z.string().trim().max(60000).optional() }).parse(req.body);
    const data = {};
    if (input.name) data.name = input.name;
    if (source.kind === 'faq' && (input.question || input.answer)) {
      const [q, a] = String(source.content ?? '').split('\n---\n');
      data.content = `${input.question ?? q}\n---\n${input.answer ?? a ?? ''}`;
      data.name = (input.question ?? q).slice(0, 160);
    }
    if (source.kind === 'text' && input.content) data.content = input.content;
    const updated = await prisma.knowledgeSource.update({ where: { id: source.id }, data: { ...data, status: 'pending' } });
    await enqueue(source.id);
    res.json(serializeSource(updated));
  })
);

router.post(
  '/bots/:id/knowledge/:sourceId/reindex',
  asyncHandler(async (req, res) => {
    const bot = await loadBot(req);
    const source = await prisma.knowledgeSource.findFirst({ where: { id: req.params.sourceId, botId: bot.id } });
    if (!source) throw notFound('Fuente no encontrada');
    const updated = await prisma.knowledgeSource.update({ where: { id: source.id }, data: { status: 'pending', error: null } });
    await enqueue(source.id);
    res.json(serializeSource(updated));
  })
);

router.delete(
  '/bots/:id/knowledge/:sourceId',
  asyncHandler(async (req, res) => {
    const bot = await loadBot(req);
    const source = await prisma.knowledgeSource.findFirst({ where: { id: req.params.sourceId, botId: bot.id } });
    if (!source) throw notFound('Fuente no encontrada');
    await removeSource(source);
    await recordAudit({ tenantId: req.auth.tenantId, actorUserId: req.auth.userId, action: 'bot.knowledge.delete', entity: 'bot', entityId: bot.id, metadata: { source: source.name, kind: source.kind } });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
//  Probar la IA (sin enviar nada por WhatsApp)
// ---------------------------------------------------------------------------
router.post(
  '/bots/:id/ai/test',
  asyncHandler(async (req, res) => {
    const bot = await loadBot(req);
    const input = z
      .object({
        message: z.string().trim().min(1).max(4000),
        history: z.array(z.object({ role: z.enum(['user', 'model']), text: z.string().max(4000) })).max(40).default([]),
      })
      .parse(req.body);
    const history = historyFromMessages(
      input.history.map((h) => ({ direction: h.role === 'user' ? 'inbound' : 'outbound', text: h.text })),
      20
    );
    try {
      const result = await answer({ bot, text: input.message, history });
      res.json(result);
    } catch (err) {
      throw badRequest(err.message);
    }
  })
);

export default router;
