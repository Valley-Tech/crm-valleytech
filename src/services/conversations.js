import prisma from '../lib/prisma.js';
import env from '../config/env.js';
import { publishEvent } from '../realtime/events.js';

/** Ventana de servicio al cliente de WhatsApp: 24 horas desde el último entrante. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWithinServiceWindow(conversation, now = new Date()) {
  if (!conversation?.lastInboundAt) return false;
  return now.getTime() - new Date(conversation.lastInboundAt).getTime() < SERVICE_WINDOW_MS;
}

export function windowExpiresAt(conversation) {
  if (!conversation?.lastInboundAt) return null;
  return new Date(new Date(conversation.lastInboundAt).getTime() + SERVICE_WINDOW_MS);
}

/** Un contacto tiene como mucho una conversación abierta por canal. */
export async function findOrCreateConversation({ tenantId, contactId, channel, integrationId }) {
  const existing = await prisma.conversation.findFirst({
    where: { tenantId, contactId, channel, status: { not: 'closed' } },
    orderBy: { createdAt: 'desc' },
  });

  if (existing) {
    if (integrationId && existing.integrationId !== integrationId) {
      return prisma.conversation.update({ where: { id: existing.id }, data: { integrationId } });
    }
    return existing;
  }

  return prisma.conversation.create({ data: { tenantId, contactId, channel, integrationId } });
}

/** Actualiza los campos que la bandeja necesita para ordenar y previsualizar. */
export async function touchConversation({ conversationId, direction, preview, occurredAt = new Date() }) {
  const data = {
    lastMessageAt: occurredAt,
    lastMessagePreview: preview?.slice(0, 280) ?? null,
  };

  if (direction === 'inbound') {
    data.lastInboundAt = occurredAt;
    data.unreadCount = { increment: 1 };
  }

  return prisma.conversation.update({ where: { id: conversationId }, data });
}

/** Minutos de inactividad que aplican a una conversación (ajuste del número, o el global). */
export async function resumeMinutesFor(conversation) {
  if (conversation?.integrationId) {
    const integration = await prisma.metaIntegration.findUnique({
      where: { id: conversation.integrationId },
      select: { botResumeMinutes: true },
    });
    if (integration?.botResumeMinutes) return integration.botResumeMinutes;
  }
  return env.BOT_PAUSE_MINUTES;
}

/**
 * Pausa el bot en una conversación porque intervino un humano (agente desde el
 * CRM, respuesta desde la app de WhatsApp Business, o traspaso pedido por el bot).
 *
 * La pausa es una ventana de inactividad que se desliza: cada mensaje de
 * cualquiera de las dos partes la vuelve a contar desde cero (extendBotPause).
 * Si pasan `minutes` sin que nadie escriba, el bot retoma el hilo solo
 * (barrido del worker + comprobación al llegar el siguiente mensaje).
 */
export async function pauseBot({ tenantId, conversationId, minutes, reason = 'agent_takeover' }) {
  const current = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true, integrationId: true, status: true } });
  const idle = minutes ?? (await resumeMinutesFor(current));
  const until = new Date(Date.now() + idle * 60 * 1000);
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { botActive: false, botPausedUntil: until, ...(current?.status === 'closed' ? {} : { status: 'pending' }) },
  });

  await publishEvent({
    tenantId,
    conversationId,
    type: 'conversation:updated',
    payload: { id: conversationId, botActive: false, botPausedUntil: until, status: conversation.status, reason },
  });

  return conversation;
}

/**
 * Hubo actividad (mensaje del cliente o del humano) mientras el bot está en
 * pausa: la ventana de inactividad vuelve a empezar. No cambia nada más.
 */
export async function extendBotPause({ tenantId, conversation }) {
  if (!conversation || conversation.botActive) return conversation;
  const idle = await resumeMinutesFor(conversation);
  const until = new Date(Date.now() + idle * 60 * 1000);
  const updated = await prisma.conversation.update({ where: { id: conversation.id }, data: { botPausedUntil: until } });
  await publishEvent({
    tenantId: tenantId ?? conversation.tenantId,
    conversationId: conversation.id,
    type: 'conversation:updated',
    payload: { id: conversation.id, botActive: false, botPausedUntil: until },
  });
  return updated;
}

export async function resumeBot({ tenantId, conversationId, reason = 'manual' }) {
  const current = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { status: true } });
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    // Si el chat quedó "pendiente" por la intervención humana, vuelve a "abierta".
    data: { botActive: true, botPausedUntil: null, ...(current?.status === 'pending' ? { status: 'open' } : {}) },
  });

  await publishEvent({
    tenantId,
    conversationId,
    type: 'conversation:updated',
    payload: { id: conversationId, botActive: true, botPausedUntil: null, status: conversation.status, reason },
  });

  return conversation;
}

/**
 * ¿Debe responder el bot en esta conversación?
 * Si la pausa ya caducó (nadie escribió en N minutos), la levanta y devuelve true.
 */
export async function shouldBotRespond(conversation) {
  if (conversation.botActive) return true;
  if (!conversation.botPausedUntil) return false;
  if (new Date(conversation.botPausedUntil).getTime() > Date.now()) return false;

  await resumeBot({ tenantId: conversation.tenantId, conversationId: conversation.id, reason: 'idle' });
  return true;
}

/**
 * Barrido periódico (worker, cada minuto): reactiva el bot en los chats cuya
 * pausa caducó aunque el cliente no haya vuelto a escribir, para que la bandeja
 * no muestre "Reactivar bot" indefinidamente. Devuelve cuántos reactivó.
 */
export async function resumeIdleBots({ now = new Date(), limit = 500 } = {}) {
  const due = await prisma.conversation.findMany({
    where: { botActive: false, botPausedUntil: { not: null, lte: now }, status: { not: 'closed' } },
    select: { id: true, tenantId: true },
    take: limit,
  });
  for (const c of due) {
    await resumeBot({ tenantId: c.tenantId, conversationId: c.id, reason: 'idle' });
  }
  return due.length;
}

/** Integración de Meta que debe usarse para responder en esta conversación. */
export async function resolveIntegration(conversation) {
  if (conversation.integrationId) {
    const integration = await prisma.metaIntegration.findUnique({ where: { id: conversation.integrationId } });
    if (integration?.active) return integration;
    // El número fue eliminado o desactivado: no se responde desde otro número por accidente.
    return null;
  }

  // Conversación sin número (creada por un bot con "to" antes de que llegara
  // un entrante): solo se asume el número si el cliente tiene uno único.
  const candidates = await prisma.metaIntegration.findMany({
    where: { tenantId: conversation.tenantId, channel: conversation.channel, active: true },
    orderBy: { connectedAt: 'asc' },
    take: 2,
  });
  return candidates.length === 1 ? candidates[0] : null;
}
