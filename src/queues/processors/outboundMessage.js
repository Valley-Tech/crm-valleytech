import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { decryptSecret } from '../../lib/crypto.js';
import { sendMessage } from '../../whatsapp/messages.js';
import { MetaApiError } from '../../whatsapp/graph.js';
import { resolveIntegration } from '../../services/conversations.js';
import { rankOf } from '../../services/messaging.js';
import { recordUsage } from '../../services/usage.js';
import { publishEvent } from '../../realtime/events.js';
import { syncRecipientFromMessage } from '../../services/campaigns.js';

async function markFailed(message, { code, reason }) {
  const updated = await prisma.message.update({
    where: { id: message.id },
    data: {
      status: 'failed',
      statusRank: rankOf('failed'),
      errorCode: code ?? null,
      errorMessage: reason?.slice(0, 500) ?? null,
    },
  });

  await publishEvent({
    tenantId: message.tenantId,
    conversationId: message.conversationId,
    type: 'message:status',
    payload: { id: message.id, status: 'failed', errorCode: code, errorMessage: reason },
  });

  await syncRecipientFromMessage(updated);
  return updated;
}

export default async function processOutboundMessage(job) {
  const { messageId } = job.data;

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: { include: { contact: true } } },
  });

  if (!message) {
    logger.warn({ messageId }, 'Mensaje saliente inexistente');
    return { skipped: 'not_found' };
  }

  // Si ya se envió (por un reintento duplicado), no se vuelve a enviar.
  if (message.statusRank >= rankOf('sent')) {
    return { skipped: 'already_sent' };
  }

  const conversation = message.conversation;
  const integration = await resolveIntegration(conversation);

  if (!integration) {
    await markFailed(message, { reason: 'El cliente no tiene una integración de WhatsApp activa' });
    return { failed: 'no_integration' };
  }

  const isLastAttempt = job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);

  try {
    const accessToken = decryptSecret(integration.accessTokenEnc);

    const { waMessageId } = await sendMessage({
      phoneNumberId: integration.phoneNumberId,
      accessToken,
      to: conversation.contact.waId,
      message: message.content,
    });

    const sentMessage = await prisma.message.update({
      where: { id: message.id },
      data: { status: 'sent', statusRank: rankOf('sent'), waMessageId },
    });
    await syncRecipientFromMessage(sentMessage);

    await recordUsage({
      tenantId: message.tenantId,
      conversationId: message.conversationId,
      messageId: message.id,
      kind: 'outbound_message',
    });

    await publishEvent({
      tenantId: message.tenantId,
      conversationId: message.conversationId,
      type: 'message:status',
      payload: { id: message.id, status: 'sent', waMessageId },
    });

    return { waMessageId };
  } catch (err) {
    if (err instanceof MetaApiError) {
      // Errores definitivos: no tiene sentido reintentar.
      if (err.isWindowClosed || err.isAuthError || !err.isRetryable) {
        await markFailed(message, { code: err.code, reason: err.message });

        if (err.isAuthError) {
          logger.error(
            { tenantId: message.tenantId, integrationId: integration.id },
            'Token de Meta inválido: la integración necesita reconectarse'
          );
        }
        return { failed: err.code ?? 'meta_error' };
      }

      if (isLastAttempt) {
        await markFailed(message, { code: err.code, reason: err.message });
        return { failed: 'retries_exhausted' };
      }
      throw err; // BullMQ reintenta con backoff exponencial
    }

    if (isLastAttempt) {
      await markFailed(message, { reason: err.message });
      return { failed: 'unexpected' };
    }
    throw err;
  }
}
