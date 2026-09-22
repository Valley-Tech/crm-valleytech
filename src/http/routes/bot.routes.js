import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/http.js';
import { notFound, conflict, badRequest } from '../../lib/errors.js';
import { requireBot } from '../middleware/auth.js';
import { sendOutbound, serializeMessage, previewOf, rankOf } from '../../services/messaging.js';
import { touchConversation } from '../../services/conversations.js';
import { recordUsage } from '../../services/usage.js';
import { publishEvent } from '../../realtime/events.js';
import { inboundQueue } from '../../queues/index.js';
import logger from '../../lib/logger.js';
import {
  findOrCreateConversation,
  pauseBot,
  isWithinServiceWindow,
  windowExpiresAt,
} from '../../services/conversations.js';

/**
 * API para los chatbots externos (ValleyTechBot, Samuelito, BlackStation).
 *
 * El bot ya no habla con Meta ni conoce el token del cliente: manda aquí lo que
 * quiere responder y el CRM decide si sale. Si un agente tomó la conversación,
 * el envío se rechaza con 409 en vez de pisar al humano.
 */

const router = Router();
router.use(requireBot);

const messageSchema = z.object({
  conversationId: z.string().uuid().optional(),
  to: z.string().min(6).optional(),
  type: z.enum(['text', 'template', 'interactive', 'image', 'document', 'audio', 'video', 'sticker', 'location', 'contacts', 'reaction']).default('text'),
  text: z.string().max(4096).optional(),
  template: z
    .object({ name: z.string(), language: z.string().default('es'), components: z.array(z.any()).default([]) })
    .optional(),
  interactive: z.any().optional(),
  media: z.any().optional(),
  location: z.any().optional(),
  contacts: z.array(z.any()).optional(),
  reaction: z.any().optional(),
  previewUrl: z.boolean().optional(),
  botState: z.record(z.any()).optional(),
  // Número del negocio por el que sale el mensaje (phone_number_id de Meta).
  // Opcional: si no viene, se usa el número que atiende el bot.
  phoneNumberId: z.string().min(3).optional(),
});

/**
 * Número de WhatsApp al que pertenece lo que manda este bot.
 *
 * Antes las conversaciones creadas por un bot (con `to`) quedaban sin número:
 * la bandeja no sabía de qué chatbot eran y no se podía responder desde el
 * CRM ("Esta conversación no tiene un número de WhatsApp asignado").
 */
async function integrationForBot(bot, phoneNumberId) {
  if (phoneNumberId) {
    const byPhone = await prisma.metaIntegration.findFirst({ where: { phoneNumberId, tenantId: bot.tenantId } });
    if (byPhone) return byPhone.id;
  }
  if (bot.metaIntegrationId) return bot.metaIntegrationId;
  const candidates = await prisma.metaIntegration.findMany({
    where: { tenantId: bot.tenantId, channel: bot.channel, active: true },
    select: { id: true },
    take: 2,
  });
  return candidates.length === 1 ? candidates[0].id : null;
}

/** Conversación indicada por id o por número destino; la deja con su número asignado. */
async function conversationForBot(bot, { conversationId, to, phoneNumberId }) {
  const { tenantId, channel } = bot;
  const integrationId = await integrationForBot(bot, phoneNumberId);

  if (conversationId) {
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
    if (!conversation) throw notFound('Conversación no encontrada');
    if (!conversation.integrationId && integrationId) {
      return prisma.conversation.update({ where: { id: conversation.id }, data: { integrationId } });
    }
    return conversation;
  }

  // Envío proactivo: si el contacto no existe todavía, se crea.
  const contact = await prisma.contact.upsert({
    where: { tenantId_channel_waId: { tenantId, channel, waId: to } },
    update: {},
    create: { tenantId, channel, waId: to },
  });
  return findOrCreateConversation({ tenantId, contactId: contact.id, channel, integrationId });
}

router.post(
  '/messages',
  asyncHandler(async (req, res) => {
    const { conversationId, to, botState, phoneNumberId, ...message } = messageSchema.parse(req.body);
    const { tenantId } = req.bot;

    if (!conversationId && !to) throw badRequest('Indica conversationId o to');

    const conversation = await conversationForBot(req.bot, { conversationId, to, phoneNumberId });

    // La regla que hace que el traspaso a humano funcione de verdad.
    if (!conversation.botActive) {
      throw conflict(
        'bot_paused',
        'Un agente tomó esta conversación: el bot no puede responder ahora.',
        { botPausedUntil: conversation.botPausedUntil }
      );
    }

    const created = await sendOutbound({
      tenantId,
      conversationId: conversation.id,
      message,
      source: 'bot',
    });

    // El bot puede guardar su propio estado en el CRM en la misma llamada:
    // así deja de depender de variables en memoria que mueren en cada deploy.
    if (botState) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { botState },
      });
    }

    res.status(201).json({ ...serializeMessage(created), conversationId: conversation.id });
  })
);

/**
 * MODO ESPEJO — para bots que todavía envían por su cuenta a la Cloud API.
 *
 * El bot ya mandó el mensaje a Meta con su propio token y aquí solo lo
 * registra para que aparezca en la bandeja (con el wamid, así los estados
 * "entregado/leído" que lleguen por webhook se enganchan a este mensaje).
 * No se envía nada. Es la transición hasta migrar al envío por el CRM.
 */
router.post(
  '/messages/record',
  asyncHandler(async (req, res) => {
    const { conversationId, to, botState, waMessageId, sentAt, phoneNumberId, ...message } = messageSchema
      .extend({
        waMessageId: z.string().min(5).optional(),
        sentAt: z.string().datetime().optional(),
      })
      .parse(req.body);
    const { tenantId } = req.bot;
    if (!conversationId && !to) throw badRequest('Indica conversationId o to');

    const conversation = await conversationForBot(req.bot, { conversationId, to, phoneNumberId });

    if (waMessageId) {
      const existing = await prisma.message.findUnique({ where: { waMessageId } });
      if (existing) return res.json({ ...serializeMessage(existing), conversationId: conversation.id, duplicate: true });
    }

    const occurredAt = sentAt ? new Date(sentAt) : new Date();
    const created = await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        contactId: conversation.contactId,
        channel: conversation.channel,
        direction: 'outbound',
        source: 'bot',
        type: message.type,
        text: message.type === 'text' ? message.text : null,
        content: message,
        status: 'sent',
        statusRank: rankOf('sent'),
        waMessageId: waMessageId ?? null,
        createdAt: occurredAt,
      },
    });

    await touchConversation({ conversationId: conversation.id, direction: 'outbound', preview: previewOf(message), occurredAt });
    await recordUsage({ tenantId, conversationId: conversation.id, messageId: created.id, kind: 'outbound_message' });
    if (botState) await prisma.conversation.update({ where: { id: conversation.id }, data: { botState } });
    await publishEvent({ tenantId, conversationId: conversation.id, type: 'message:created', payload: serializeMessage(created) });

    res.status(201).json({ ...serializeMessage(created), conversationId: conversation.id });
  })
);

/**
 * MODO ESPEJO — reenvío del webhook de Meta.
 *
 * Si la app de Meta del cliente sigue apuntando su webhook al bot (y no al
 * CRM), el bot reenvía aquí el cuerpo tal cual lo recibió. El CRM lo procesa
 * igual que si viniera de Meta (contactos, conversaciones, estados, medios)
 * pero NO se lo vuelve a entregar al bot por el Bot Gateway.
 */
router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const body = req.body;
    if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
      throw badRequest('El cuerpo debe ser el webhook de Meta tal cual (object: whatsapp_business_account)');
    }
    const jobs = [];
    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        jobs.push({
          name: change.field ?? 'unknown',
          data: {
            entryId: entry.id,
            field: change.field,
            value: change.value,
            receivedAt: new Date().toISOString(),
            options: { skipBots: true, forwardedByBot: req.bot.id },
          },
        });
      }
    }
    if (jobs.length > 0) await inboundQueue.addBulk(jobs);
    logger.debug({ bot: req.bot.name, count: jobs.length }, 'Webhook reenviado por un bot');
    res.status(202).json({ queued: jobs.length });
  })
);

/** ¿Puede el bot responder a este número? (para bots que reciben el webhook directo). */
router.get(
  '/conversations/lookup',
  asyncHandler(async (req, res) => {
    const { tenantId, channel } = req.bot;
    const waId = String(req.query.to ?? '').trim();
    if (!waId) throw badRequest('Indica ?to=<número en formato internacional sin +>');

    const contact = await prisma.contact.findUnique({ where: { tenantId_channel_waId: { tenantId, channel, waId } } });
    const conversation = contact
      ? await prisma.conversation.findFirst({
          where: { tenantId, contactId: contact.id, status: { not: 'closed' } },
          orderBy: { lastMessageAt: 'desc' },
        })
      : null;

    res.json({
      found: Boolean(conversation),
      conversationId: conversation?.id ?? null,
      botActive: conversation ? conversation.botActive : true,
      botPausedUntil: conversation?.botPausedUntil ?? null,
      botState: conversation?.botState ?? null,
      contact: contact ? { id: contact.id, waId: contact.waId, name: contact.name } : null,
    });
  })
);

/** El bot decide escalar a un humano. */
router.post(
  '/conversations/:id/handoff',
  asyncHandler(async (req, res) => {
    const { tenantId } = req.bot;
    const input = z
      .object({ reason: z.string().max(200).optional(), minutes: z.number().int().positive().optional() })
      .parse(req.body ?? {});

    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!conversation) throw notFound('Conversación no encontrada');

    const updated = await pauseBot({
      tenantId,
      conversationId: conversation.id,
      minutes: input.minutes,
      reason: input.reason ?? 'bot_handoff',
    });

    res.json({ botActive: updated.botActive, botPausedUntil: updated.botPausedUntil, status: updated.status });
  })
);

/** Estado conversacional del bot, persistido en Postgres en vez de en memoria. */
router.patch(
  '/conversations/:id/state',
  asyncHandler(async (req, res) => {
    const { tenantId } = req.bot;
    const botState = z.record(z.any()).parse(req.body ?? {});

    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!conversation) throw notFound('Conversación no encontrada');

    const updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { botState },
    });

    res.json({ botState: updated.botState });
  })
);

router.get(
  '/conversations/:id',
  asyncHandler(async (req, res) => {
    const { tenantId } = req.bot;
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, tenantId },
      include: { contact: true },
    });
    if (!conversation) throw notFound('Conversación no encontrada');

    res.json({
      id: conversation.id,
      channel: conversation.channel,
      status: conversation.status,
      botActive: conversation.botActive,
      botPausedUntil: conversation.botPausedUntil,
      botState: conversation.botState,
      withinServiceWindow: isWithinServiceWindow(conversation),
      windowExpiresAt: windowExpiresAt(conversation),
      contact: { id: conversation.contact.id, waId: conversation.contact.waId, name: conversation.contact.name },
    });
  })
);

export default router;
