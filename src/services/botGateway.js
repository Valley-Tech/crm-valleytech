import axios from 'axios';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { decryptSecret } from '../lib/crypto.js';
import { signBotPayload } from '../lib/signature.js';
import { botDispatchQueue } from '../queues/index.js';
import { windowExpiresAt } from './conversations.js';

/**
 * Bot Gateway: el contrato entre el CRM y tus chatbots.
 *
 *  1. El CRM hace POST del evento normalizado al endpoint del bot, firmado.
 *  2. El bot responde llamando a POST /api/v1/bot/messages con su API key.
 *  3. El CRM decide si ese envío sale: solo él sabe si un agente tomó el chat.
 *
 * Los bots dejan de recibir webhooks de Meta y de manejar tokens de clientes.
 */

export function buildBotEvent({ event, tenant, conversation, contact, message, integration }) {
  return {
    event,
    sentAt: new Date().toISOString(),
    tenant: { id: tenant.id, name: tenant.name },
    conversation: {
      id: conversation.id,
      channel: conversation.channel,
      status: conversation.status,
      pipelineStage: conversation.pipelineStage,
      botActive: conversation.botActive,
      botState: conversation.botState ?? null,
      lastInboundAt: conversation.lastInboundAt,
      windowExpiresAt: windowExpiresAt(conversation),
    },
    contact: {
      id: contact.id,
      waId: contact.waId,
      name: contact.name,
      tags: contact.tags,
    },
    message: message
      ? {
          id: message.id,
          waMessageId: message.waMessageId,
          type: message.type,
          text: message.text,
          content: message.content,
          createdAt: message.createdAt,
        }
      : null,
    integration: integration
      ? {
          phoneNumberId: integration.phoneNumberId,
          displayPhoneNumber: integration.displayPhoneNumber,
          wabaId: integration.wabaId,
        }
      : null,
  };
}

/** Encola el despacho hacia todos los bots activos del tenant en ese canal. */
export async function dispatchToBots({ tenantId, channel, payload, integrationId = null }) {
  // Cada bot atiende su número; los bots sin número asignado reciben todo.
  const bots = await prisma.botIntegration.findMany({
    where: {
      tenantId,
      channel,
      active: true,
      OR: [{ metaIntegrationId: null }, ...(integrationId ? [{ metaIntegrationId: integrationId }] : [])],
    },
  });

  if (bots.length === 0) return 0;

  await Promise.all(
    bots.map((bot) =>
      botDispatchQueue.add('dispatch', { botId: bot.id, payload }, { jobId: `bot:${bot.id}:${payload.message?.id ?? Date.now()}` })
    )
  );

  return bots.length;
}

/** Entrega efectiva al bot. La ejecuta el worker. */
export async function deliverToBot({ botId, payload }) {
  const bot = await prisma.botIntegration.findUnique({ where: { id: botId } });
  if (!bot || !bot.active) {
    logger.warn({ botId }, 'Bot inexistente o inactivo: se descarta el despacho');
    return { skipped: true };
  }

  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const signature = signBotPayload(decryptSecret(bot.signingSecret), timestamp, body);

  const response = await axios({
    method: 'POST',
    url: bot.endpointUrl,
    data: body,
    timeout: 15000,
    headers: {
      'Content-Type': 'application/json',
      'X-ValleyTech-Event': payload.event,
      'X-ValleyTech-Timestamp': timestamp,
      'X-ValleyTech-Signature': `sha256=${signature}`,
    },
    validateStatus: (status) => status >= 200 && status < 300,
  });

  await prisma.botIntegration.update({
    where: { id: bot.id },
    data: { lastDispatchAt: new Date() },
  });

  return { status: response.status };
}
