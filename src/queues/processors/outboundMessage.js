import { DelayedError } from 'bullmq';
import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { sendMessage } from '../../whatsapp/messages.js';
import { MetaApiError } from '../../whatsapp/graph.js';
import { resolveIntegration } from '../../services/conversations.js';
import { rankOf } from '../../services/messaging.js';
import { recordUsage } from '../../services/usage.js';
import { publishEvent } from '../../realtime/events.js';
import { syncRecipientFromMessage } from '../../services/campaigns.js';
import { metaCredentials } from '../../whatsapp/credentials.js';
import { describeMetaError } from '../../lib/metaErrors.js';

async function markFailed(message, { code, reason }) {
  // Con código de Meta se guarda la explicación en español; sin código, el motivo tal cual.
  const explained = code ? describeMetaError(code, reason) : reason;
  const updated = await prisma.message.update({
    where: { id: message.id },
    data: {
      status: 'failed',
      statusRank: rankOf('failed'),
      errorCode: code ?? null,
      errorMessage: explained?.slice(0, 500) ?? null,
    },
  });

  await publishEvent({
    tenantId: message.tenantId,
    conversationId: message.conversationId,
    type: 'message:status',
    payload: { id: message.id, status: 'failed', errorCode: code, errorMessage: updated.errorMessage },
  });

  await syncRecipientFromMessage(updated);
  return updated;
}

/**
 * Orden por conversación. La cola envía varios mensajes a la vez (concurrencia
 * 5), así que dos mensajes seguidos de un bot ("Bienvenido…" y luego los
 * botones) podían llegar a Meta en orden inverso. Antes de enviar uno se
 * comprueba que no quede otro anterior de la misma conversación aún en cola;
 * si lo hay, este se aplaza medio segundo (sin gastar reintentos). Si el
 * anterior lleva demasiado tiempo atascado, se deja pasar para no bloquear.
 */
const ORDER_RECHECK_MS = 500;
const ORDER_MAX_WAIT_MS = 90 * 1000;

async function waitingForEarlier(message) {
  const earlier = await prisma.message.findFirst({
    where: {
      conversationId: message.conversationId,
      direction: 'outbound',
      status: 'queued',
      id: { not: message.id },
      OR: [{ createdAt: { lt: message.createdAt } }, { createdAt: message.createdAt, id: { lt: message.id } }],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true },
  });
  if (!earlier) return false;
  return Date.now() - new Date(earlier.createdAt).getTime() < ORDER_MAX_WAIT_MS;
}

export default async function processOutboundMessage(job, token) {
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

  // Respeta el orden: primero el mensaje anterior de la misma conversación.
  if (message.status === 'queued' && (await waitingForEarlier(message))) {
    await job.moveToDelayed(Date.now() + ORDER_RECHECK_MS, token);
    throw new DelayedError();
  }

  const conversation = message.conversation;
  const integration = await resolveIntegration(conversation);

  if (!integration) {
    await markFailed(message, { reason: 'Esta conversación no tiene un número de WhatsApp activo (eliminado o desactivado)' });
    return { failed: 'no_integration' };
  }

  const isLastAttempt = job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);

  try {
    const accessToken = metaCredentials(integration);

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
