import { Worker } from 'bullmq';
import { connection } from './messageQueue.js';
import prisma from '../db/prisma.js';
import { runBotFlow } from '../bot/botEngine.js';

const worker = new Worker(
  'whatsapp-events',
  async (job) => {
    const { tenantId, phoneNumberId, field, value } = job.data;

    switch (field) {
      case 'messages':
        return handleMessagesField(tenantId, phoneNumberId, value);
      case 'account_update':
        return handleAccountUpdate(tenantId, value);
      case 'history':
        return handleHistorySync(tenantId, value);
      case 'smb_app_state_sync':
        return handleContactSync(tenantId, value);
      case 'smb_message_echoes':
        return handleMessageEchoes(tenantId, value);
      default:
        console.warn(`Campo de webhook no manejado: ${field}`);
    }
  },
  { connection, concurrency: 10 }
);

// --- messages: puede traer mensajes entrantes O actualizaciones de estado ---
async function handleMessagesField(tenantId, phoneNumberId, value) {
  if (value.statuses) {
    for (const statusUpdate of value.statuses) {
      await prisma.message.updateMany({
        where: { whatsappMessageId: statusUpdate.id },
        data: { status: statusUpdate.status },
      });
    }
    return;
  }

  for (const incomingMessage of value.messages ?? []) {
    const waId = incomingMessage.from;
    const profileName = value.contacts?.[0]?.profile?.name;

    const contact = await prisma.contact.upsert({
      where: { tenantId_waId: { tenantId, waId } },
      update: { name: profileName ?? undefined },
      create: { tenantId, waId, name: profileName },
    });

    let conversation = await prisma.conversation.findFirst({
      where: { tenantId, contactId: contact.id, status: { not: 'closed' } },
    });
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: { tenantId, contactId: contact.id },
      });
    }

    const text = incomingMessage.text?.body ?? null;

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'inbound',
        source: 'cloud_api',
        type: incomingMessage.type,
        content: incomingMessage,
        whatsappMessageId: incomingMessage.id,
        status: 'delivered',
      },
    });

    if (conversation.botActive) {
      await runBotFlow({ tenantId, phoneNumberId, conversation, contact, incomingMessageText: text });
    }
    // TODO: si !botActive, emitir por WebSocket al agente asignado para que lo vea en vivo.
  }
}

// --- account_update: conexión, desconexión o reconexión de una cuenta ---
async function handleAccountUpdate(tenantId, value) {
  const event = value.event;
  if (event === 'PARTNER_REMOVED' || event === 'ACCOUNT_OFFBOARDED') {
    await prisma.metaIntegration.updateMany({
      where: { tenantId },
      data: { syncStatus: 'not_applicable' },
    });
    // TODO: notificar al tenant que su número se desconectó y por qué (value.disconnection_info).
  }
}

// --- history: sincronización inicial de mensajes tras onboarding de coexistencia ---
async function handleHistorySync(tenantId, value) {
  for (const historyChunk of value.history ?? []) {
    if (historyChunk.errors) {
      // El negocio no compartió su historial (error 2593109) — no es un fallo del sistema.
      continue;
    }

    for (const thread of historyChunk.threads ?? []) {
      const waId = thread.id;
      const contact = await prisma.contact.upsert({
        where: { tenantId_waId: { tenantId, waId } },
        update: {},
        create: { tenantId, waId },
      });

      let conversation = await prisma.conversation.findFirst({ where: { tenantId, contactId: contact.id } });
      if (!conversation) {
        conversation = await prisma.conversation.create({ data: { tenantId, contactId: contact.id } });
      }

      for (const msg of thread.messages ?? []) {
        if (msg.type === 'media_placeholder') continue; // llega después en un webhook separado

        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            direction: msg.to ? 'outbound' : 'inbound',
            source: msg.to ? 'smb_echo' : 'cloud_api',
            type: msg.type,
            content: msg,
            whatsappMessageId: msg.id,
            status: msg.history_context?.status?.toLowerCase() ?? 'sent',
          },
        });
      }
    }
  }
}

// --- smb_app_state_sync: contactos agregados/editados desde la app WhatsApp Business ---
async function handleContactSync(tenantId, value) {
  for (const item of value.state_sync ?? []) {
    if (item.type !== 'contact') continue;
    const { phone_number: waId, full_name: fullName } = item.contact ?? {};
    if (!waId) continue;

    if (item.action === 'remove') {
      // Se conserva el contacto para no perder historial; solo se podría marcar como inactivo.
      continue;
    }

    await prisma.contact.upsert({
      where: { tenantId_waId: { tenantId, waId } },
      update: { name: fullName },
      create: { tenantId, waId, name: fullName },
    });
  }
}

// --- smb_message_echoes: mensajes enviados manualmente desde el teléfono del negocio ---
async function handleMessageEchoes(tenantId, value) {
  for (const echo of value.message_echoes ?? []) {
    const waId = echo.to;
    const contact = await prisma.contact.upsert({
      where: { tenantId_waId: { tenantId, waId } },
      update: {},
      create: { tenantId, waId },
    });

    let conversation = await prisma.conversation.findFirst({ where: { tenantId, contactId: contact.id } });
    if (!conversation) {
      conversation = await prisma.conversation.create({ data: { tenantId, contactId: contact.id } });
    }

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'outbound',
        source: 'smb_echo',
        type: echo.type,
        content: echo,
        whatsappMessageId: echo.id,
        status: 'sent',
      },
    });

    // Si el dueño del negocio respondió a mano, el bot se detiene en ese chat:
    // ya hubo intervención humana y no debe seguir automatizando.
    await prisma.conversation.update({ where: { id: conversation.id }, data: { botActive: false } });
  }
}

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} falló:`, err.message);
});

export default worker;
