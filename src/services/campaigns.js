import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { campaignQueue } from '../queues/index.js';
import { publishEvent } from '../realtime/events.js';

/**
 * Campañas: envío masivo de una plantilla aprobada a un segmento de contactos.
 *
 * El envío real lo hace el worker (processors/campaignSend.js), que recorre los
 * destinatarios pendientes y encola cada mensaje en la cola de salida normal —
 * así hereda el límite de tasa y los reintentos de cualquier otro envío.
 */

/** Resuelve {{contact.name}}, {{contact.waId}} y {{contact.customFields.x}}. */
export function resolveParam(raw, contact) {
  if (typeof raw !== 'string') return raw;
  return raw.replace(/\{\{\s*contact\.([\w.]+)\s*\}\}/g, (_, path) => {
    const value = path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), contact);
    return value == null ? '' : String(value);
  });
}

/** Sustituye los parámetros de texto en los componentes de la plantilla. */
export function buildComponentsFor(components, contact) {
  if (!Array.isArray(components)) return [];
  return components.map((component) => ({
    ...component,
    parameters: (component.parameters ?? []).map((param) =>
      param.type === 'text' ? { ...param, text: resolveParam(param.text, contact) } : param
    ),
  }));
}

/** Construye la lista de destinatarios a partir del filtro elegido. */
export async function selectContacts({ tenantId, contactIds, tags, all }) {
  if (Array.isArray(contactIds) && contactIds.length > 0) {
    return prisma.contact.findMany({
      where: { tenantId, id: { in: contactIds }, blocked: false, channel: 'whatsapp' },
    });
  }
  if (Array.isArray(tags) && tags.length > 0) {
    return prisma.contact.findMany({
      where: { tenantId, blocked: false, channel: 'whatsapp', tags: { hasSome: tags } },
    });
  }
  if (all) {
    return prisma.contact.findMany({ where: { tenantId, blocked: false, channel: 'whatsapp' } });
  }
  throw badRequest('Indica contactIds, tags o all: true para elegir destinatarios');
}

export async function createCampaign({ tenantId, userId, input }) {
  const template = await prisma.template.findFirst({
    where: { tenantId, name: input.templateName, language: input.templateLanguage ?? 'es' },
  });
  if (!template) throw badRequest('La plantilla no existe en este cliente; sincroniza primero');
  if (template.status !== 'approved') {
    throw badRequest(`La plantilla "${template.name}" no está aprobada (estado: ${template.status})`);
  }

  const contacts = await selectContacts({ tenantId, ...input.recipients });
  if (contacts.length === 0) throw badRequest('El segmento elegido no tiene contactos');

  const campaign = await prisma.$transaction(async (tx) => {
    const created = await tx.campaign.create({
      data: {
        tenantId,
        integrationId: input.integrationId ?? null,
        name: input.name,
        templateName: template.name,
        templateLanguage: template.language,
        components: input.components ?? null,
        status: input.scheduledAt ? 'scheduled' : 'draft',
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        totalRecipients: contacts.length,
        createdByUserId: userId,
      },
    });

    await tx.campaignRecipient.createMany({
      data: contacts.map((contact) => ({
        campaignId: created.id,
        tenantId,
        contactId: contact.id,
        waId: contact.waId,
      })),
      skipDuplicates: true,
    });

    return created;
  });

  if (campaign.status === 'scheduled') {
    const delay = Math.max(0, new Date(campaign.scheduledAt).getTime() - Date.now());
    await campaignQueue.add('run', { campaignId: campaign.id }, { jobId: `campaign:${campaign.id}`, delay });
  }

  return campaign;
}

export async function startCampaign({ tenantId, campaignId }) {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId } });
  if (!campaign) throw notFound('Campaña no encontrada');
  if (!['draft', 'scheduled', 'paused'].includes(campaign.status)) {
    throw conflict('campaign_not_startable', `La campaña está en estado ${campaign.status}`);
  }

  const updated = await prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: 'running', startedAt: campaign.startedAt ?? new Date() },
  });

  // jobId único por arranque: si se pausa y se reanuda, el job anterior ya terminó.
  await campaignQueue.add('run', { campaignId: campaign.id }, { jobId: `campaign:${campaign.id}:${Date.now()}` });
  await publishEvent({ tenantId, type: 'campaign:updated', payload: { id: campaign.id, status: 'running' } });
  return updated;
}

export async function pauseCampaign({ tenantId, campaignId }) {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId } });
  if (!campaign) throw notFound('Campaña no encontrada');
  if (campaign.status !== 'running') throw conflict('campaign_not_running', 'Solo se pausa una campaña en curso');
  const updated = await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'paused' } });
  await publishEvent({ tenantId, type: 'campaign:updated', payload: { id: campaign.id, status: 'paused' } });
  return updated;
}

export async function cancelCampaign({ tenantId, campaignId }) {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId } });
  if (!campaign) throw notFound('Campaña no encontrada');
  if (['completed', 'cancelled'].includes(campaign.status)) return campaign;

  const updated = await prisma.$transaction(async (tx) => {
    await tx.campaignRecipient.updateMany({
      where: { campaignId: campaign.id, status: 'pending' },
      data: { status: 'skipped' },
    });
    return tx.campaign.update({ where: { id: campaign.id }, data: { status: 'cancelled', completedAt: new Date() } });
  });
  await publishEvent({ tenantId, type: 'campaign:updated', payload: { id: campaign.id, status: 'cancelled' } });
  return updated;
}

/** Recalcula contadores a partir de los destinatarios (nunca se desincronizan). */
export async function refreshCampaignCounters(campaignId) {
  const rows = await prisma.campaignRecipient.groupBy({
    by: ['status'],
    where: { campaignId },
    _count: { _all: true },
  });
  const count = (status) => rows.find((r) => r.status === status)?._count._all ?? 0;

  const sent = count('sent') + count('delivered') + count('read');
  const data = {
    sentCount: sent,
    deliveredCount: count('delivered') + count('read'),
    readCount: count('read'),
    failedCount: count('failed'),
  };

  const pending = count('pending') + count('queued');
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (campaign && campaign.status === 'running' && pending === 0) {
    data.status = 'completed';
    data.completedAt = new Date();
  }

  const updated = await prisma.campaign.update({ where: { id: campaignId }, data });
  logger.debug({ campaignId, ...data }, 'Contadores de campaña actualizados');
  return updated;
}

/** Cuando cambia el estado de un mensaje de campaña, se refleja en el destinatario. */
export async function syncRecipientFromMessage(message) {
  if (!message.campaignId) return;
  const map = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };
  const status = map[message.status];
  if (!status) return;

  await prisma.campaignRecipient.updateMany({
    where: { messageId: message.id },
    data: { status, errorMessage: message.errorMessage ?? undefined, sentAt: status === 'sent' ? new Date() : undefined },
  });
  await refreshCampaignCounters(message.campaignId);
}
