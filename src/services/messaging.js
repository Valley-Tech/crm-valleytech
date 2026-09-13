import prisma from '../lib/prisma.js';
import { notFound, unprocessable, badRequest } from '../lib/errors.js';
import { outboundQueue } from '../queues/index.js';
import { publishEvent } from '../realtime/events.js';
import { isWithinServiceWindow, windowExpiresAt, touchConversation } from './conversations.js';

/**
 * Los estados de un mensaje solo avanzan.
 *
 * Los webhooks de status de Meta no llegan en orden: sin esta escala, un
 * mensaje ya marcado como "read" podía retroceder a "delivered".
 * "failed" tiene el rango más alto porque es terminal.
 */
export const STATUS_RANK = {
  received: 1,
  queued: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 9,
};

export function rankOf(status) {
  return STATUS_RANK[status] ?? 0;
}

/** Texto corto para la lista de conversaciones. */
export function previewOf(message) {
  if (message.text) return message.text;
  if (message.type === 'template') return `[plantilla: ${message.template?.name ?? ''}]`;
  if (message.type === 'interactive') return '[mensaje interactivo]';
  return `[${message.type}]`;
}

/**
 * Único camino de salida del CRM.
 *
 * Persiste el mensaje ANTES de enviarlo (en estado "queued"), lo encola y deja
 * que el worker haga la llamada a Meta. Así el agente ve inmediatamente lo que
 * envió, y ningún mensaje se pierde si el envío falla: queda en la base con su
 * error y en la cola de fallidos.
 */
export async function sendOutbound({
  tenantId,
  conversationId,
  message,
  source = 'agent',
  userId = null,
  campaignId = null,
  allowOutsideWindow = false,
}) {
  if (!message?.type) throw badRequest('El mensaje necesita un campo "type"');
  if (message.type === 'text' && !message.text?.trim()) throw badRequest('El texto no puede estar vacío');
  if (message.type === 'template' && !message.template?.name) {
    throw badRequest('Una plantilla necesita template.name');
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: { contact: true },
  });
  if (!conversation) throw notFound('Conversación no encontrada');

  const insideWindow = isWithinServiceWindow(conversation);
  if (message.type !== 'template' && !insideWindow && !allowOutsideWindow) {
    throw unprocessable(
      'service_window_closed',
      'La ventana de 24 horas está cerrada: fuera de ella WhatsApp solo acepta plantillas aprobadas.',
      { lastInboundAt: conversation.lastInboundAt, windowExpiredAt: windowExpiresAt(conversation) }
    );
  }

  const created = await prisma.message.create({
    data: {
      tenantId,
      conversationId,
      contactId: conversation.contactId,
      channel: conversation.channel,
      direction: 'outbound',
      source,
      type: message.type,
      text: message.type === 'text' ? message.text : null,
      content: message,
      status: 'queued',
      statusRank: STATUS_RANK.queued,
      sentByUserId: userId,
      campaignId,
    },
  });

  await touchConversation({
    conversationId,
    direction: 'outbound',
    preview: previewOf(message),
    occurredAt: created.createdAt,
  });

  // jobId = id del mensaje: si esta función se llama dos veces por el mismo
  // mensaje, BullMQ descarta el duplicado en vez de enviarlo dos veces.
  await outboundQueue.add('send', { messageId: created.id }, { jobId: `msg:${created.id}` });

  await publishEvent({
    tenantId,
    conversationId,
    type: 'message:created',
    payload: serializeMessage(created),
  });

  return created;
}

/** Forma en la que un mensaje sale por la API y por WebSocket. */
export function serializeMessage(message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    channel: message.channel,
    direction: message.direction,
    source: message.source,
    type: message.type,
    text: message.text,
    content: message.content,
    status: message.status,
    waMessageId: message.waMessageId,
    errorCode: message.errorCode,
    errorMessage: message.errorMessage,
    mediaStorageKey: message.mediaStorageKey,
    mediaMimeType: message.mediaMimeType,
    mediaFilename: message.mediaFilename,
    sentByUserId: message.sentByUserId,
    createdAt: message.createdAt,
  };
}
