import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/http.js';
import { notFound, conflict, badRequest } from '../../lib/errors.js';
import { requireBot } from '../middleware/auth.js';
import { sendOutbound, serializeMessage } from '../../services/messaging.js';
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
  type: z.enum(['text', 'template', 'interactive', 'image', 'document', 'audio', 'video', 'location']).default('text'),
  text: z.string().max(4096).optional(),
  template: z
    .object({ name: z.string(), language: z.string().default('es'), components: z.array(z.any()).default([]) })
    .optional(),
  interactive: z.any().optional(),
  media: z.any().optional(),
  location: z.any().optional(),
  botState: z.record(z.any()).optional(),
});

router.post(
  '/messages',
  asyncHandler(async (req, res) => {
    const { conversationId, to, botState, ...message } = messageSchema.parse(req.body);
    const { tenantId, channel } = req.bot;

    if (!conversationId && !to) throw badRequest('Indica conversationId o to');

    let conversation;

    if (conversationId) {
      conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
      if (!conversation) throw notFound('Conversación no encontrada');
    } else {
      // Envío proactivo: si el contacto no existe todavía, se crea.
      const contact = await prisma.contact.upsert({
        where: { tenantId_channel_waId: { tenantId, channel, waId: to } },
        update: {},
        create: { tenantId, channel, waId: to },
      });
      conversation = await findOrCreateConversation({ tenantId, contactId: contact.id, channel });
    }

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
