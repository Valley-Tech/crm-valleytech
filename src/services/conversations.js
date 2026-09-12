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

/**
 * Pausa el bot en una conversación porque intervino un humano.
 * La pausa caduca sola: si el agente no vuelve, el bot retoma el hilo.
 */
export async function pauseBot({ tenantId, conversationId, minutes = env.BOT_PAUSE_MINUTES, reason = 'agent_takeover' }) {
  const until = new Date(Date.now() + minutes * 60 * 1000);
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { botActive: false, botPausedUntil: until, status: 'pending' },
  });

  await publishEvent({
    tenantId,
    conversationId,
    type: 'conversation:updated',
    payload: { id: conversationId, botActive: false, botPausedUntil: until, reason },
  });

  return conversation;
}

export async function resumeBot({ tenantId, conversationId }) {
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { botActive: true, botPausedUntil: null },
  });

  await publishEvent({
    tenantId,
    conversationId,
    type: 'conversation:updated',
    payload: { id: conversationId, botActive: true, botPausedUntil: null },
  });

  return conversation;
}

/**
 * ¿Debe responder el bot en esta conversación?
 * Si la pausa ya caducó, la levanta y devuelve true.
 */
export async function shouldBotRespond(conversation) {
  if (conversation.botActive) return true;
  if (!conversation.botPausedUntil) return false;
  if (new Date(conversation.botPausedUntil).getTime() > Date.now()) return false;

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { botActive: true, botPausedUntil: null },
  });
  return true;
}

/** Integración de Meta que debe usarse para responder en esta conversación. */
export async function resolveIntegration(conversation) {
  if (conversation.integrationId) {
    const integration = await prisma.metaIntegration.findUnique({ where: { id: conversation.integrationId } });
    if (integration?.active) return integration;
  }

  return prisma.metaIntegration.findFirst({
    where: { tenantId: conversation.tenantId, channel: conversation.channel, active: true },
    orderBy: { connectedAt: 'asc' },
  });
}
