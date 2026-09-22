import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { asyncHandler } from '../../lib/http.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { sendOutbound, serializeMessage } from '../../services/messaging.js';
import {
  pauseBot,
  resumeBot,
  isWithinServiceWindow,
  windowExpiresAt,
  resolveIntegration,
} from '../../services/conversations.js';
import { publishEvent } from '../../realtime/events.js';
import { recordAudit } from '../../services/audit.js';
import { uploadMedia } from '../../whatsapp/media.js';
import { markAsRead } from '../../whatsapp/messages.js';
import { putObject, deleteObject } from '../../storage/index.js';
import { metaCredentials } from '../../whatsapp/credentials.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

/** Tipo de mensaje de WhatsApp según el MIME del archivo subido. */
function mediaTypeFor(mimeType = '') {
  if (mimeType.startsWith('image/')) return mimeType === 'image/webp' ? 'sticker' : 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

const router = Router();
router.use(requireAuth);

/** Toda consulta parte del tenant del token. Nunca se acepta uno del cliente. */
async function loadConversation(req) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, tenantId: req.auth.tenantId },
    include: { contact: true, assignedUser: { select: { id: true, name: true } }, integration: { select: { id: true, displayPhoneNumber: true, verifiedName: true, active: true } } },
  });
  if (!conversation) throw notFound('Conversación no encontrada');
  return conversation;
}

/**
 * Chatbots activos del cliente, para saber cuál atiende cada conversación.
 * Un bot atiende un número concreto (metaIntegrationId) o todos (null).
 */
async function loadBots(tenantId) {
  return prisma.botIntegration.findMany({
    where: { tenantId, active: true },
    select: { id: true, name: true, metaIntegrationId: true },
    orderBy: { createdAt: 'asc' },
  });
}

function botFor(conversation, bots = []) {
  if (!bots.length) return null;
  const byNumber = conversation.integrationId ? bots.find((b) => b.metaIntegrationId === conversation.integrationId) : null;
  const forAll = bots.find((b) => !b.metaIntegrationId);
  const bot = byNumber ?? forAll ?? null;
  return bot ? { id: bot.id, name: bot.name } : null;
}

function serializeConversation(conversation, bots = []) {
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
    // Número del cliente por el que va este chat (null si el número fue eliminado).
    integration: conversation.integration
      ? {
          id: conversation.integration.id,
          displayPhoneNumber: conversation.integration.displayPhoneNumber,
          verifiedName: conversation.integration.verifiedName,
          active: conversation.integration.active,
        }
      : null,
    // Chatbot que atiende este chat (por el número), para mostrarlo en la bandeja.
    bot: botFor(conversation, bots),
  };
}

/** Serializa con el chatbot resuelto (una consulta de bots por llamada). */
async function serializeFull(tenantId, conversation) {
  return serializeConversation(conversation, await loadBots(tenantId));
}

// ---------------------------------------------------------------------------
// Bandeja
// ---------------------------------------------------------------------------
const listQuery = z.object({
  status: z.enum(['open', 'pending', 'closed']).optional(),
  assignedUserId: z.string().uuid().optional(),
  unassigned: z.coerce.boolean().optional(),
  botActive: z.coerce.boolean().optional(),
  unread: z.coerce.boolean().optional(),
  stage: z.string().optional(),
  // id de un número de WhatsApp, o "none" para los chats sin número asignado.
  integrationId: z.string().optional(),
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get(
  '/conversations',
  asyncHandler(async (req, res) => {
    const { status, assignedUserId, unassigned, botActive, unread, stage, integrationId, q, limit, offset } = listQuery.parse(req.query);

    const where = {
      tenantId: req.auth.tenantId,
      ...(integrationId ? { integrationId: integrationId === 'none' ? null : integrationId } : {}),
      ...(status ? { status } : {}),
      ...(assignedUserId ? { assignedUserId } : {}),
      ...(unassigned ? { assignedUserId: null } : {}),
      ...(botActive !== undefined ? { botActive } : {}),
      ...(unread ? { unreadCount: { gt: 0 } } : {}),
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

    const [items, total, bots] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: { contact: true, assignedUser: { select: { id: true, name: true } }, integration: { select: { id: true, displayPhoneNumber: true, verifiedName: true, active: true } } },
        orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
      }),
      prisma.conversation.count({ where }),
      loadBots(req.auth.tenantId),
    ]);

    res.json({ items: items.map((c) => serializeConversation(c, bots)), total, limit, offset });
  })
);

/**
 * Números de WhatsApp del cliente con el chatbot que los atiende. Es lo que la
 * bandeja usa para el filtro "por número / chatbot" y para las etiquetas de
 * color. Solo datos visibles (nunca tokens), por eso lo puede leer un agente.
 */
router.get(
  '/inbox/channels',
  asyncHandler(async (req, res) => {
    const [integrations, bots, orphans] = await Promise.all([
      prisma.metaIntegration.findMany({
        where: { tenantId: req.auth.tenantId },
        select: { id: true, displayPhoneNumber: true, verifiedName: true, active: true, channel: true },
        orderBy: { connectedAt: 'asc' },
      }),
      loadBots(req.auth.tenantId),
      prisma.conversation.count({ where: { tenantId: req.auth.tenantId, integrationId: null } }),
    ]);
    const forAll = bots.filter((b) => !b.metaIntegrationId).map((b) => ({ id: b.id, name: b.name }));
    res.json({
      items: integrations.map((i) => ({
        ...i,
        bots: [...bots.filter((b) => b.metaIntegrationId === i.id).map((b) => ({ id: b.id, name: b.name })), ...forAll],
      })),
      botsForAll: forAll,
      withoutNumber: orphans,
    });
  })
);

router.get(
  '/conversations/:id',
  asyncHandler(async (req, res) => {
    res.json(await serializeFull(req.auth.tenantId, await loadConversation(req)));
  })
);

// ---------------------------------------------------------------------------
// Hilo de mensajes
// ---------------------------------------------------------------------------
// Vaciar y eliminar (como en WhatsApp)
// ---------------------------------------------------------------------------

/** Borra los archivos multimedia de una lista de mensajes (mejor esfuerzo). */
async function deleteMediaFiles(messages) {
  const keys = messages.map((m) => m.mediaStorageKey).filter(Boolean);
  await Promise.all(keys.map((key) => deleteObject(key)));
  return keys.length;
}

/**
 * Vaciar chat: borra todos los mensajes pero conserva la conversación, el
 * contacto, las etiquetas, las notas y la asignación. Igual que "Vaciar chat"
 * en WhatsApp. La ventana de 24 h se mantiene (depende del último entrante).
 */
router.post(
  '/conversations/:id/clear',
  requireRole('agent'),
  asyncHandler(async (req, res) => {
    const conversation = await loadConversation(req);
    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id, tenantId: req.auth.tenantId },
      select: { id: true, mediaStorageKey: true },
    });
    const files = await deleteMediaFiles(messages);
    const deleted = await prisma.message.deleteMany({ where: { conversationId: conversation.id, tenantId: req.auth.tenantId } });

    const updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessagePreview: null, unreadCount: 0 },
      include: { contact: true, assignedUser: { select: { id: true, name: true } }, integration: { select: { id: true, displayPhoneNumber: true, verifiedName: true, active: true } } },
    });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: 'conversation.clear',
      entity: 'conversation',
      entityId: conversation.id,
      metadata: { messages: deleted.count, files },
    });
    await publishEvent({ tenantId: req.auth.tenantId, conversationId: conversation.id, type: 'conversation:cleared', payload: { id: conversation.id } });

    res.json({ ...(await serializeFull(req.auth.tenantId, updated)), deletedMessages: deleted.count });
  })
);

async function deleteConversations(req, ids) {
  const conversations = await prisma.conversation.findMany({
    where: { id: { in: ids }, tenantId: req.auth.tenantId },
    select: { id: true },
  });
  const found = conversations.map((c) => c.id);
  if (found.length === 0) return { deleted: 0, files: 0 };

  const messages = await prisma.message.findMany({
    where: { conversationId: { in: found }, tenantId: req.auth.tenantId, mediaStorageKey: { not: null } },
    select: { id: true, mediaStorageKey: true },
  });
  const files = await deleteMediaFiles(messages);
  // Mensajes y notas se borran en cascada (FK ON DELETE CASCADE).
  const result = await prisma.conversation.deleteMany({ where: { id: { in: found }, tenantId: req.auth.tenantId } });

  await recordAudit({
    tenantId: req.auth.tenantId,
    actorUserId: req.auth.userId,
    action: 'conversation.delete',
    entity: 'conversation',
    entityId: found.length === 1 ? found[0] : null,
    metadata: { ids: found, files },
  });
  for (const id of found) {
    await publishEvent({ tenantId: req.auth.tenantId, conversationId: id, type: 'conversation:deleted', payload: { id } });
  }
  return { deleted: result.count, files };
}

/**
 * Eliminar chat: borra la conversación con sus mensajes y notas. El contacto
 * se conserva (como en WhatsApp: borrar un chat no borra el contacto). Si el
 * cliente vuelve a escribir, se abre una conversación nueva.
 */
router.delete(
  '/conversations/:id',
  requireRole('agent'),
  asyncHandler(async (req, res) => {
    await loadConversation(req);
    const result = await deleteConversations(req, [req.params.id]);
    res.json({ ok: true, ...result });
  })
);

/** Eliminar varias a la vez (selección múltiple en la bandeja). */
router.post(
  '/conversations/bulk-delete',
  requireRole('agent'),
  asyncHandler(async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).parse(req.body);
    const result = await deleteConversations(req, ids);
    res.json({ ok: true, ...result });
  })
);

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

/**
 * Enviar un archivo: se sube a Meta (que devuelve un media id) y luego se
 * envía como mensaje de imagen/video/audio/documento con ese id.
 */
router.post(
  '/conversations/:id/media',
  requireRole('agent'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const conversation = await loadConversation(req);
    if (!req.file) throw badRequest('Adjunta un archivo en el campo "file"');

    const integration = await resolveIntegration(conversation);
    if (!integration) throw badRequest('Este cliente no tiene un número de WhatsApp activo');

    const type = mediaTypeFor(req.file.mimetype);
    const { mediaId } = await uploadMedia({
      phoneNumberId: integration.phoneNumberId,
      accessToken: metaCredentials(integration),
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      filename: req.file.originalname,
    });
    if (!mediaId) throw badRequest('Meta no devolvió un id para el archivo');

    const media = { id: mediaId };
    if (req.body?.caption && type !== 'audio' && type !== 'sticker') media.caption = String(req.body.caption);
    if (type === 'document') media.filename = req.file.originalname;

    const created = await sendOutbound({
      tenantId: req.auth.tenantId,
      conversationId: conversation.id,
      message: { type, media },
      source: 'agent',
      userId: req.auth.userId,
    });

    // Guardamos también una copia local para que la bandeja pueda mostrar
    // lo que el agente envió sin volver a pedirlo a Meta.
    let withMedia = created;
    try {
      const ext = req.file.originalname.includes('.') ? '.' + req.file.originalname.split('.').pop() : '';
      const key = `${req.auth.tenantId}/${created.id}${ext}`;
      await putObject(key, req.file.buffer, req.file.mimetype);
      withMedia = await prisma.message.update({
        where: { id: created.id },
        data: { mediaId, mediaStorageKey: key, mediaMimeType: req.file.mimetype, mediaFilename: req.file.originalname, mediaSizeBytes: req.file.size },
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'No se pudo guardar la copia local del archivo enviado');
    }

    if (conversation.botActive) {
      await pauseBot({ tenantId: req.auth.tenantId, conversationId: conversation.id });
    }

    res.status(201).json(serializeMessage(withMedia));
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
      include: { contact: true, assignedUser: { select: { id: true, name: true } }, integration: { select: { id: true, displayPhoneNumber: true, verifiedName: true, active: true } } },
    });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: 'conversation.update',
      entity: 'conversation',
      entityId: updated.id,
      metadata: data,
    });

    const serialized = await serializeFull(req.auth.tenantId, updated);
    await publishEvent({
      tenantId: req.auth.tenantId,
      conversationId: updated.id,
      type: 'conversation:updated',
      payload: serialized,
    });

    res.json(serialized);
  })
);

router.post(
  '/conversations/:id/read',
  asyncHandler(async (req, res) => {
    const conversation = await loadConversation(req);
    const updated = await prisma.conversation.update({
      where: { id: req.params.id },
      data: { unreadCount: 0 },
      include: { contact: true, assignedUser: { select: { id: true, name: true } }, integration: { select: { id: true, displayPhoneNumber: true, verifiedName: true, active: true } } },
    });
    res.json(await serializeFull(req.auth.tenantId, updated));

    // Los dos checks azules para el cliente. Mejor esfuerzo: no bloquea la respuesta.
    try {
      const lastInbound = await prisma.message.findFirst({
        where: { conversationId: conversation.id, direction: 'inbound', waMessageId: { not: null } },
        orderBy: { createdAt: 'desc' },
      });
      const integration = lastInbound ? await resolveIntegration(conversation) : null;
      if (lastInbound && integration) {
        await markAsRead({
          phoneNumberId: integration.phoneNumberId,
          accessToken: metaCredentials(integration),
          waMessageId: lastInbound.waMessageId,
        });
      }
    } catch (err) {
      logger.debug({ err: err.message }, 'No se pudo marcar como leído en Meta');
    }
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
    const tag = req.query.tag ? String(req.query.tag) : undefined;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);
    const where = {
      tenantId: req.auth.tenantId,
      ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { waId: { contains: q } }] } : {}),
      ...(tag ? { tags: { has: tag } } : {}),
    };
    const [items, total, bots] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          // Último chat del contacto: dice por qué número (y chatbot) llegó.
          conversations: {
            orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
            take: 1,
            select: { id: true, integrationId: true, integration: { select: { id: true, displayPhoneNumber: true, verifiedName: true, active: true } } },
          },
        },
      }),
      prisma.contact.count({ where }),
      loadBots(req.auth.tenantId),
    ]);
    res.json({
      items: items.map(({ conversations, ...contact }) => {
        const last = conversations[0] ?? null;
        return {
          ...contact,
          conversationId: last?.id ?? null,
          integration: last?.integration ?? null,
          bot: last ? botFor(last, bots) : null,
        };
      }),
      total,
      limit,
      offset,
    });
  })
);

router.get(
  '/contacts/:id',
  asyncHandler(async (req, res) => {
    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id, tenantId: req.auth.tenantId },
      include: {
        conversations: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { id: true, status: true, pipelineStage: true, lastMessageAt: true, lastMessagePreview: true, createdAt: true, integrationId: true, integration: { select: { id: true, displayPhoneNumber: true, verifiedName: true, active: true } } },
        },
      },
    });
    if (!contact) throw notFound('Contacto no encontrado');
    const [messages, bots] = await Promise.all([
      prisma.message.count({ where: { contactId: contact.id } }),
      loadBots(req.auth.tenantId),
    ]);
    res.json({
      ...contact,
      conversations: contact.conversations.map((c) => ({ ...c, bot: botFor(c, bots) })),
      messageCount: messages,
    });
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

    const updated = await prisma.contact.update({ where: { id: req.params.id }, data });

    // La bandeja muestra el nombre en la lista: se avisa a los que la tienen abierta.
    if (data.name !== undefined || data.tags !== undefined) {
      const conversations = await prisma.conversation.findMany({
        where: { contactId: updated.id, tenantId: req.auth.tenantId },
        select: { id: true },
      });
      for (const c of conversations) {
        await publishEvent({
          tenantId: req.auth.tenantId,
          conversationId: c.id,
          type: 'conversation:updated',
          payload: { id: c.id, contact: { id: updated.id, waId: updated.waId, name: updated.name, tags: updated.tags } },
        });
      }
    }

    res.json(updated);
  })
);

/**
 * Eliminar contactos: se borran el contacto, todos sus chats (mensajes,
 * archivos, notas) y su rastro en campañas. No toca el WhatsApp del cliente
 * ni Meta. Si vuelve a escribir, se crea de nuevo como contacto sin nombre.
 */
async function deleteContacts(req, ids) {
  const contacts = await prisma.contact.findMany({
    where: { id: { in: ids }, tenantId: req.auth.tenantId },
    select: { id: true, waId: true, name: true, conversations: { select: { id: true } } },
  });
  if (contacts.length === 0) return { deleted: 0, conversations: 0, files: 0 };

  const conversationIds = contacts.flatMap((c) => c.conversations.map((x) => x.id));
  const messages = conversationIds.length
    ? await prisma.message.findMany({
        where: { conversationId: { in: conversationIds }, tenantId: req.auth.tenantId, mediaStorageKey: { not: null } },
        select: { id: true, mediaStorageKey: true },
      })
    : [];
  const files = await deleteMediaFiles(messages);

  // Conversaciones → mensajes y notas en cascada; destinatarios de campaña en cascada.
  const result = await prisma.contact.deleteMany({ where: { id: { in: contacts.map((c) => c.id) }, tenantId: req.auth.tenantId } });

  await recordAudit({
    tenantId: req.auth.tenantId,
    actorUserId: req.auth.userId,
    action: 'contact.delete',
    entity: 'contact',
    entityId: contacts.length === 1 ? contacts[0].id : null,
    metadata: { contacts: contacts.map((c) => ({ id: c.id, waId: c.waId, name: c.name })), conversations: conversationIds.length, files },
  });
  for (const id of conversationIds) {
    await publishEvent({ tenantId: req.auth.tenantId, conversationId: id, type: 'conversation:deleted', payload: { id } });
  }
  return { deleted: result.count, conversations: conversationIds.length, files };
}

router.delete(
  '/contacts/:id',
  requireRole('agent'),
  asyncHandler(async (req, res) => {
    const existing = await prisma.contact.findFirst({ where: { id: req.params.id, tenantId: req.auth.tenantId }, select: { id: true } });
    if (!existing) throw notFound('Contacto no encontrado');
    res.json({ ok: true, ...(await deleteContacts(req, [existing.id])) });
  })
);

router.post(
  '/contacts/bulk-delete',
  requireRole('agent'),
  asyncHandler(async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).parse(req.body);
    res.json({ ok: true, ...(await deleteContacts(req, ids)) });
  })
);

export default router;
