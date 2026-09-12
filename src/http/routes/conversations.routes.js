import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/http.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { sendOutbound, serializeMessage } from '../../services/messaging.js';
import {
  pauseBot,
  resumeBot,
  isWithinServiceWindow,
  windowExpiresAt,
} from '../../services/conversations.js';
import { publishEvent } from '../../realtime/events.js';
import { recordAudit } from '../../services/audit.js';

const router = Router();
router.use(requireAuth);

/** Toda consulta parte del tenant del token. Nunca se acepta uno del cliente. */
async function loadConversation(req) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, tenantId: req.auth.tenantId },
    include: { contact: true, assignedUser: { select: { id: true, name: true } } },
  });
  if (!conversation) throw notFound('Conversación no encontrada');
  return conversation;
}

function serializeConversation(conversation) {
  return {
    id: conversation.id,
    channel: conversation.channel,
    status: conversation.status,
    pipelineStage: conversation.pipelineStage,
    botActive: conversation.botActive,
    botPausedUntil: conversation.botPausedUntil,
    unreadCount: conversation.unreadCount,
    lastMessageAt: conversation.lastMessageAt,
    lastMessagePreview: conversation.lastMessagePreview,
    lastInboundAt: conversation.lastInboundAt,
    withinServiceWindow: isWithinServiceWindow(conversation),
    windowExpiresAt: windowExpiresAt(conversation),
    contact: conversation.contact
      ? {
          id: conversation.contact.id,
          waId: conversation.contact.waId,
          name: conversation.contact.name,
          tags: conversation.contact.tags,
        }
      : null,
    assignedUser: conversation.assignedUser ?? null,
  };
}

// ---------------------------------------------------------------------------
// Bandeja
// ---------------------------------------------------------------------------
const listQuery = z.object({
  status: z.enum(['open', 'pending', 'closed']).optional(),
  assignedUserId: z.string().uuid().optional(),
  stage: z.string().optional(),
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get(
  '/conversations',
  asyncHandler(async (req, res) => {
    const { status, assignedUserId, stage, q, limit, offset } = listQuery.parse(req.query);

    const where = {
      tenantId: req.auth.tenantId,
      ...(status ? { status } : {}),
      ...(assignedUserId ? { assignedUserId } : {}),
      ...(stage ? { pipelineStage: stage } : {}),
      ...(q
        ? {
            contact: {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { waId: { contains: q } },
              ],
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: { contact: true, assignedUser: { select: { id: true, name: true } } },
        orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
      }),
      prisma.conversation.count({ where }),
    ]);

    res.json({ items: items.map(serializeConversation), total, limit, offset });
  })
);

router.get(
  '/conversations/:id',
  asyncHandler(async (req, res) => {
    res.json(serializeConversation(await loadConversation(req)));
  })
);

// ---------------------------------------------------------------------------
// Hilo de mensajes
// ---------------------------------------------------------------------------
router.get(
  '/conversations/:id/messages',
  asyncHandler(async (req, res) => {
    await loadConversation(req);

    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const before = req.query.before ? new Date(String(req.query.before)) : undefined;

    const messages = await prisma.message.findMany({
      where: {
        conversationId: req.params.id,
        tenantId: req.auth.tenantId,
        ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // Se devuelven en orden cronológico, que es como los pinta la bandeja.
    res.json({ items: messages.reverse().map(serializeMessage) });
  })
);

const sendSchema = z.object({
  type: z.enum(['text', 'template', 'interactive', 'image', 'document', 'audio', 'video', 'location']).default('text'),
  text: z.string().max(4096).optional(),
  template: z
    .object({
      name: z.string(),
      language: z.string().default('es'),
      components: z.array(z.any()).default([]),
    })
    .optional(),
  interactive: z.any().optional(),
  media: z.any().optional(),
  location: z.any().optional(),
  keepBotActive: z.boolean().default(false),
});

router.post(
  '/conversations/:id/messages',
  requireRole('agent'),
  asyncHandler(async (req, res) => {
    const conversation = await loadConversation(req);
    const { keepBotActive, ...message } = sendSchema.parse(req.body);

    const created = await sendOutbound({
      tenantId: req.auth.tenantId,
      conversationId: conversation.id,
      message,
      source: 'agent',
      userId: req.auth.userId,
    });

    // Si respondió un humano, el bot se calla en ese hilo (con caducidad).
    if (!keepBotActive && conversation.botActive) {
      await pauseBot({ tenantId: req.auth.tenantId, conversationId: conversation.id });
    }

    res.status(201).json(serializeMessage(created));
  })
);

// ---------------------------------------------------------------------------
// Estado de la conversación
// ---------------------------------------------------------------------------
const patchSchema = z.object({
  status: z.enum(['open', 'pending', 'closed']).optional(),
  pipelineStage: z.string().min(1).max(60).optional(),
  assignedUserId: z.string().uuid().nullable().optional(),
});

router.patch(
  '/conversations/:id',
  requireRole('agent'),
  asyncHandler(async (req, res) => {
    await loadConversation(req);
    const data = patchSchema.parse(req.body);
    if (Object.keys(data).length === 0) throw badRequest('No hay nada que actualizar');

    if (data.assignedUserId) {
      const agent = await prisma.user.findFirst({
        where: { id: data.assignedUserId, tenantId: req.auth.tenantId, active: true },
      });
      if (!agent) throw badRequest('El agente indicado no existe en este cliente');
    }

    const updated = await prisma.conversation.update({
      where: { id: req.params.id },
      data,
      include: { contact: true, assignedUser: { select: { id: true, name: true } } },
    });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: 'conversation.update',
      entity: 'conversation',
      entityId: updated.id,
      metadata: data,
    });

    await publishEvent({
      tenantId: req.auth.tenantId,
      conversationId: updated.id,
      type: 'conversation:updated',
      payload: serializeConversation(updated),
    });

    res.json(serializeConversation(updated));
  })
);

router.post(
  '/conversations/:id/read',
  asyncHandler(async (req, res) => {
    await loadConversation(req);
    const updated = await prisma.conversation.update({
      where: { id: req.params.id },
      data: { unreadCount: 0 },
      include: { contact: true, assignedUser: { select: { id: true, name: true } } },
    });
    res.json(serializeConversation(updated));
  })
);

router.post(
  '/conversations/:id/bot/pause',
  requireRole('agent'),
  asyncHandler(async (req, res) => {
    await loadConversation(req);
    const minutes = Number(req.body?.minutes) || undefined;
    const updated = await pauseBot({
      tenantId: req.auth.tenantId,
      conversationId: req.params.id,
      minutes,
      reason: 'manual',
    });
    res.json({ botActive: updated.botActive, botPausedUntil: updated.botPausedUntil });
  })
);

router.post(
  '/conversations/:id/bot/resume',
  requireRole('agent'),
  asyncHandler(async (req, res) => {
    await loadConversation(req);
    const updated = await resumeBot({ tenantId: req.auth.tenantId, conversationId: req.params.id });
    res.json({ botActive: updated.botActive, botPausedUntil: updated.botPausedUntil });
  })
);

// ---------------------------------------------------------------------------
// Notas internas (nunca salen a WhatsApp)
// ---------------------------------------------------------------------------
router.get(
  '/conversations/:id/notes',
  asyncHandler(async (req, res) => {
    await loadConversation(req);
    const notes = await prisma.conversationNote.findMany({
      where: { conversationId: req.params.id, tenantId: req.auth.tenantId },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ items: notes });
  })
);

router.post(
  '/conversations/:id/notes',
  requireRole('agent'),
  asyncHandler(async (req, res) => {
    await loadConversation(req);
    const body = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body);

    const note = await prisma.conversationNote.create({
      data: {
        tenantId: req.auth.tenantId,
        conversationId: req.params.id,
        userId: req.auth.userId,
        body: body.body,
      },
      include: { user: { select: { id: true, name: true } } },
    });

    res.status(201).json(note);
  })
);

// ---------------------------------------------------------------------------
// Contactos
// ---------------------------------------------------------------------------
router.get(
  '/contacts',
  asyncHandler(async (req, res) => {
    const q = req.query.q ? String(req.query.q) : undefined;
    const items = await prisma.contact.findMany({
      where: {
        tenantId: req.auth.tenantId,
        ...(q
          ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { waId: { contains: q } }] }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(Number(req.query.limit ?? 50), 200),
    });
    res.json({ items });
  })
);

router.patch(
  '/contacts/:id',
  requireRole('agent'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        name: z.string().max(160).optional(),
        email: z.string().email().nullable().optional(),
        tags: z.array(z.string().max(40)).max(30).optional(),
        customFields: z.record(z.any()).optional(),
        blocked: z.boolean().optional(),
      })
      .parse(req.body);

    const existing = await prisma.contact.findFirst({
      where: { id: req.params.id, tenantId: req.auth.tenantId },
    });
    if (!existing) throw notFound('Contacto no encontrado');

    res.json(await prisma.contact.update({ where: { id: req.params.id }, data }));
  })
);

export default router;
