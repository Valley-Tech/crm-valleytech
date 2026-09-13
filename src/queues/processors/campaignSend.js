import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { sendOutbound } from '../../services/messaging.js';
import { findOrCreateConversation } from '../../services/conversations.js';
import { buildComponentsFor, refreshCampaignCounters } from '../../services/campaigns.js';

const BATCH = 100;

/**
 * Recorre los destinatarios pendientes de una campaña y encola un mensaje de
 * plantilla por cada uno. Se detiene si la campaña deja de estar "running".
 */
export default async function processCampaignSend(job) {
  const { campaignId } = job.data;

  let campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return { skipped: 'not_found' };

  if (campaign.status === 'scheduled') {
    campaign = await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'running', startedAt: new Date() },
    });
  }
  if (campaign.status !== 'running') return { skipped: campaign.status };

  let processed = 0;

  for (;;) {
    // Releer el estado en cada lote: así "pausar" surte efecto en segundos.
    const current = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!current || current.status !== 'running') break;

    const batch = await prisma.campaignRecipient.findMany({
      where: { campaignId, status: 'pending' },
      include: { contact: true },
      take: BATCH,
      orderBy: { createdAt: 'asc' },
    });
    if (batch.length === 0) break;

    for (const recipient of batch) {
      try {
        const conversation = await findOrCreateConversation({
          tenantId: campaign.tenantId,
          contactId: recipient.contactId,
          channel: 'whatsapp',
          integrationId: campaign.integrationId ?? undefined,
        });

        const message = await sendOutbound({
          tenantId: campaign.tenantId,
          conversationId: conversation.id,
          source: 'campaign',
          campaignId: campaign.id,
          allowOutsideWindow: true,
          message: {
            type: 'template',
            template: {
              name: campaign.templateName,
              language: campaign.templateLanguage,
              components: buildComponentsFor(campaign.components, recipient.contact),
            },
          },
        });

        await prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: { status: 'queued', messageId: message.id },
        });
        processed += 1;
      } catch (err) {
        logger.warn({ campaignId, recipientId: recipient.id, err: err.message }, 'Destinatario de campaña falló');
        await prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: { status: 'failed', errorMessage: err.message?.slice(0, 500) },
        });
      }
    }
  }

  await refreshCampaignCounters(campaignId);
  return { processed };
}
