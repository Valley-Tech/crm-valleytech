import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { mediaQueue } from '../index.js';
import { publishEvent } from '../../realtime/events.js';
import { recordUsage } from '../../services/usage.js';
import {
  findOrCreateConversation,
  touchConversation,
  shouldBotRespond,
} from '../../services/conversations.js';
import { rankOf, serializeMessage } from '../../services/messaging.js';
import { buildBotEvent, dispatchToBots } from '../../services/botGateway.js';
import { syncRecipientFromMessage } from '../../services/campaigns.js';
import { noteUnknownPhoneNumber, touchIntegrationActivity, notePartnerAdded, clearPartnerAdded } from '../../services/webhookDiagnostics.js';
import { describeMetaError } from '../../lib/metaErrors.js';

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

/** Encuentra a qué cliente pertenece el evento. */
async function resolveIntegration({ entryId, value }) {
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (phoneNumberId) {
    const byPhone = await prisma.metaIntegration.findUnique({
      where: { phoneNumberId },
      include: { tenant: true },
    });
    if (byPhone) return byPhone;
  }

  if (entryId) {
    const byWaba = await prisma.metaIntegration.findFirst({
      where: { wabaId: entryId, active: true },
      include: { tenant: true },
      orderBy: { connectedAt: 'asc' },
    });
    if (byWaba) return byWaba;
  }

  return null;
}

export default async function processInboundEvent(job) {
  const { entryId, field, value, options = {} } = job.data;

  const integration = await resolveIntegration({ entryId, value });
  if (!integration) {
    // Un negocio nuevo compartió su WABA con nosotros (registro alojado por
    // Meta o registro insertado fuera del CRM): todavía no existe integración,
    // pero hay que recordarlo para poder conectarlo desde el panel.
    if (field === 'account_update' && value?.event === 'PARTNER_ADDED') {
      const wabaId = value?.waba_info?.waba_id ?? entryId;
      const businessId = value?.waba_info?.owner_business_id ?? null;
      await notePartnerAdded({ wabaId, businessId }).catch(() => {});
      logger.info({ wabaId, businessId }, 'PARTNER_ADDED: WABA nueva compartida con el CRM, pendiente de conectar');
      return { pending: 'partner_added', wabaId };
    }
    const phoneNumberId = value?.metadata?.phone_number_id;
    logger.warn({ entryId, field, phoneNumberId }, 'Evento de un número o WABA no registrado: se descarta');
    await noteUnknownPhoneNumber(phoneNumberId, entryId).catch(() => {});
    return { skipped: 'unknown_integration' };
  }

  await touchIntegrationActivity(integration.id, {
    inbound: field === 'messages' && Array.isArray(value?.messages) && value.messages.length > 0,
  });

  switch (field) {
    case 'messages':
      return handleMessagesField(integration, value, options);
    case 'message_template_status_update':
      return handleTemplateStatus(integration, value);
    case 'account_update':
      return handleAccountUpdate(integration, value);
    case 'smb_message_echoes':
      return handleMessageEchoes(integration, value);
    case 'smb_app_state_sync':
      return handleContactSync(integration, value);
    case 'history':
      return handleHistorySync(integration, value);
    default:
      logger.info({ field }, 'Campo de webhook sin manejador');
      return { skipped: 'unhandled_field' };
  }
}

// ---------------------------------------------------------------------------
// messages: trae mensajes entrantes, cambios de estado o errores
// ---------------------------------------------------------------------------
async function handleMessagesField(integration, value, options = {}) {
  if (Array.isArray(value?.statuses) && value.statuses.length > 0) {
    await handleStatuses(integration, value.statuses);
  }

  const results = [];
  for (const incoming of value?.messages ?? []) {
    results.push(await handleIncomingMessage(integration, value, incoming, options));
  }
  return { processed: results.length };
}

async function handleStatuses(integration, statuses) {
  for (const status of statuses) {
    const rank = rankOf(status.status);
    if (!rank) continue;

    const metaError = status.errors?.[0];

    // Solo avanza: si el mensaje ya está en un estado posterior, no se toca.
    const updated = await prisma.message.updateMany({
      where: { waMessageId: status.id, statusRank: { lt: rank } },
      data: {
        status: status.status,
        statusRank: rank,
        errorCode: metaError?.code ?? undefined,
        // Meta manda títulos en inglés ("Re-engagement message"); se guarda
        // la explicación en español con qué hacer.
        errorMessage: metaError ? describeMetaError(metaError.code, metaError.title ?? metaError.message).slice(0, 500) : undefined,
      },
    });

    if (updated.count > 0) {
      const message = await prisma.message.findUnique({ where: { waMessageId: status.id } });
      if (message) {
        await publishEvent({
          tenantId: message.tenantId,
          conversationId: message.conversationId,
          type: 'message:status',
          payload: { id: message.id, status: message.status, errorCode: message.errorCode, errorMessage: message.errorMessage },
        });

        // Si el mensaje pertenece a una campaña, el destinatario avanza con él.
        await syncRecipientFromMessage(message);

        // Meta factura por plantilla enviada: se contabiliza al confirmarse.
        if (status.status === 'sent' && status.pricing?.category) {
          await recordUsage({
            tenantId: message.tenantId,
            conversationId: message.conversationId,
            messageId: message.id,
            kind: 'template_message',
            category: status.pricing.category,
          });
        }
      }
    }
  }
}

async function handleIncomingMessage(integration, value, incoming, options = {}) {
  const { tenantId, channel } = integration;
  const waId = incoming.from;
  const profileName = value?.contacts?.find((c) => c.wa_id === waId)?.profile?.name;

  const contact = await prisma.contact.upsert({
    where: { tenantId_channel_waId: { tenantId, channel, waId } },
    update: profileName ? { name: profileName } : {},
    create: { tenantId, channel, waId, name: profileName },
  });

  const conversation = await findOrCreateConversation({
    tenantId,
    contactId: contact.id,
    channel,
    integrationId: integration.id,
  });

  const text = extractText(incoming);

  let message;
  try {
    message = await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        contactId: contact.id,
        channel,
        direction: 'inbound',
        source: 'cloud_api',
        type: incoming.type ?? 'unknown',
        text,
        content: incoming,
        waMessageId: incoming.id,
        status: 'received',
        statusRank: rankOf('received'),
        mediaId: MEDIA_TYPES.has(incoming.type) ? incoming[incoming.type]?.id : undefined,
        mediaMimeType: MEDIA_TYPES.has(incoming.type) ? incoming[incoming.type]?.mime_type : undefined,
        mediaFilename: incoming.document?.filename ?? undefined,
      },
    });
  } catch (err) {
    // P2002 = wa_message_id duplicado. Meta reintentó un webhook que ya
    // habíamos procesado: no es un error, es la idempotencia funcionando.
    if (err.code === 'P2002') {
      logger.debug({ waMessageId: incoming.id }, 'Mensaje duplicado ignorado');
      return { duplicated: true };
    }
    throw err;
  }

  const updatedConversation = await touchConversation({
    conversationId: conversation.id,
    direction: 'inbound',
    preview: text ?? `[${incoming.type}]`,
    occurredAt: new Date(Number(incoming.timestamp ?? Date.now() / 1000) * 1000),
  });

  await recordUsage({
    tenantId,
    conversationId: conversation.id,
    messageId: message.id,
    kind: 'inbound_message',
  });

  if (message.mediaId) {
    await mediaQueue.add('download', { messageId: message.id }, { jobId: `media-${message.id}` });
  }

  await publishEvent({
    tenantId,
    conversationId: conversation.id,
    type: 'message:created',
    payload: serializeMessage(message),
  });

  // options.skipBots: el evento lo reenvió un bot que ya lo está atendiendo
  // (modo espejo), así que no se le vuelve a entregar por el Bot Gateway.
  if (!options.skipBots && (await shouldBotRespond(updatedConversation))) {
    const payload = buildBotEvent({
      event: 'message.received',
      tenant: integration.tenant,
      conversation: updatedConversation,
      contact,
      message,
      integration,
    });
    await dispatchToBots({ tenantId, channel, payload, integrationId: integration.id });
  }

  return { messageId: message.id };
}

/** Saca el texto útil de cualquier forma de mensaje entrante. */
function extractText(incoming) {
  if (incoming.text?.body) return incoming.text.body;
  if (incoming.button?.text) return incoming.button.text;
  if (incoming.interactive?.button_reply) return incoming.interactive.button_reply.title;
  if (incoming.interactive?.list_reply) return incoming.interactive.list_reply.title;
  if (incoming.interactive?.nfm_reply?.response_json) return '[respuesta de formulario]';
  if (incoming.image?.caption) return incoming.image.caption;
  if (incoming.video?.caption) return incoming.video.caption;
  if (incoming.document?.caption) return incoming.document.caption;
  if (incoming.order) return '[pedido del catálogo]';
  if (incoming.location) return '[ubicación]';
  return null;
}

// ---------------------------------------------------------------------------
// Plantillas: Meta avisa cuando aprueba o rechaza una
// ---------------------------------------------------------------------------
async function handleTemplateStatus(integration, value) {
  const name = value?.message_template_name;
  const language = value?.message_template_language ?? 'es';
  if (!name) return { skipped: 'no_template_name' };

  const status = String(value.event ?? '').toLowerCase();
  const mapped = ['approved', 'rejected', 'paused', 'disabled'].includes(status) ? status : 'pending';

  await prisma.template.updateMany({
    where: { tenantId: integration.tenantId, name, language },
    data: { status: mapped, syncedAt: new Date() },
  });

  return { template: name, status: mapped };
}

// ---------------------------------------------------------------------------
// account_update: conexión, desconexión, cambios de calidad
// ---------------------------------------------------------------------------
async function handleAccountUpdate(integration, value) {
  const event = value?.event;

  if (event === 'PARTNER_ADDED') await clearPartnerAdded(integration.wabaId).catch(() => {});

  if (event === 'PARTNER_REMOVED' || event === 'ACCOUNT_OFFBOARDED' || event === 'DISABLED_UPDATE') {
    await prisma.metaIntegration.update({
      where: { id: integration.id },
      data: { active: false },
    });
    logger.warn({ tenantId: integration.tenantId, event }, 'Integración de Meta desactivada');
  }

  if (value?.current_limit || value?.event === 'PHONE_NUMBER_QUALITY_UPDATE') {
    await prisma.metaIntegration.update({
      where: { id: integration.id },
      data: {
        messagingTier: value.current_limit ?? integration.messagingTier,
        qualityRating: value.event === 'PHONE_NUMBER_QUALITY_UPDATE' ? value.current_limit : integration.qualityRating,
      },
    });
  }

  await publishEvent({
    tenantId: integration.tenantId,
    type: 'integration:updated',
    payload: { id: integration.id, event },
  });

  return { event };
}

// ---------------------------------------------------------------------------
// Coexistencia: el dueño responde desde la app de WhatsApp Business
// ---------------------------------------------------------------------------
async function handleMessageEchoes(integration, value) {
  const { tenantId, channel } = integration;

  for (const echo of value?.message_echoes ?? []) {
    const waId = echo.to;
    if (!waId) continue;

    const contact = await prisma.contact.upsert({
      where: { tenantId_channel_waId: { tenantId, channel, waId } },
      update: {},
      create: { tenantId, channel, waId },
    });

    const conversation = await findOrCreateConversation({
      tenantId,
      contactId: contact.id,
      channel,
      integrationId: integration.id,
    });

    try {
      await prisma.message.create({
        data: {
          tenantId,
          conversationId: conversation.id,
          contactId: contact.id,
          channel,
          direction: 'outbound',
          source: 'smb_echo',
          type: echo.type ?? 'text',
          text: echo.text?.body ?? null,
          content: echo,
          waMessageId: echo.id,
          status: 'sent',
          statusRank: rankOf('sent'),
        },
      });
    } catch (err) {
      if (err.code !== 'P2002') throw err;
      continue;
    }

    await touchConversation({
      conversationId: conversation.id,
      direction: 'outbound',
      preview: echo.text?.body ?? `[${echo.type}]`,
    });

    const saved = await prisma.message.findUnique({ where: { waMessageId: echo.id } });
    if (saved) {
      await publishEvent({
        tenantId,
        conversationId: conversation.id,
        type: 'message:created',
        payload: serializeMessage(saved),
      });
    }

    // Un eco es un mensaje enviado desde la app de WhatsApp Business: puede ser
    // el dueño o la IA de Meta, y el webhook no distingue. Solo pausa el bot del
    // Bot Gateway si la integración lo pide explícitamente.
    if (integration.echoPausesBot) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { botActive: false, botPausedUntil: null },
      });
    }
  }

  return { echoes: value?.message_echoes?.length ?? 0 };
}

async function handleContactSync(integration, value) {
  const { tenantId, channel } = integration;

  for (const item of value?.state_sync ?? []) {
    if (item.type !== 'contact') continue;
    const waId = item.contact?.phone_number;
    if (!waId || item.action === 'remove') continue;

    await prisma.contact.upsert({
      where: { tenantId_channel_waId: { tenantId, channel, waId } },
      update: { name: item.contact.full_name ?? undefined },
      create: { tenantId, channel, waId, name: item.contact.full_name },
    });
  }

  return { synced: value?.state_sync?.length ?? 0 };
}

async function handleHistorySync(integration, value) {
  const { tenantId, channel } = integration;
  let imported = 0;

  for (const chunk of value?.history ?? []) {
    if (chunk.errors) continue; // el negocio no compartió su historial

    for (const thread of chunk.threads ?? []) {
      const waId = thread.id;
      if (!waId) continue;

      const contact = await prisma.contact.upsert({
        where: { tenantId_channel_waId: { tenantId, channel, waId } },
        update: {},
        create: { tenantId, channel, waId },
      });

      const conversation = await findOrCreateConversation({
        tenantId,
        contactId: contact.id,
        channel,
        integrationId: integration.id,
      });

      for (const msg of thread.messages ?? []) {
        if (msg.type === 'media_placeholder') continue; // llega en un webhook aparte

        try {
          await prisma.message.create({
            data: {
              tenantId,
              conversationId: conversation.id,
              contactId: contact.id,
              channel,
              direction: msg.to ? 'outbound' : 'inbound',
              source: 'history',
              type: msg.type ?? 'text',
              text: msg.text?.body ?? null,
              content: msg,
              waMessageId: msg.id,
              status: msg.to ? 'sent' : 'received',
              statusRank: rankOf(msg.to ? 'sent' : 'received'),
            },
          });
          imported += 1;
        } catch (err) {
          if (err.code !== 'P2002') throw err;
        }
      }
    }
  }

  await prisma.metaIntegration.update({
    where: { id: integration.id },
    data: { syncStatus: 'complete' },
  });

  return { imported };
}
