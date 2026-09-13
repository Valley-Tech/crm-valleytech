import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAudit } from '../../services/audit.js';
import {
  createCampaign,
  startCampaign,
  pauseCampaign,
  cancelCampaign,
  refreshCampaignCounters,
  selectContacts,
} from '../../services/campaigns.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

function serialize(campaign) {
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    templateName: campaign.templateName,
    templateLanguage: campaign.templateLanguage,
    components: campaign.components,
    integrationId: campaign.integrationId,
    scheduledAt: campaign.scheduledAt,
    startedAt: campaign.startedAt,
    completedAt: campaign.completedAt,
    totalRecipients: campaign.totalRecipients,
    sentCount: campaign.sentCount,
    deliveredCount: campaign.deliveredCount,
    readCount: campaign.readCount,
    failedCount: campaign.failedCount,
    createdBy: campaign.createdBy ? { id: campaign.createdBy.id, name: campaign.createdBy.name } : null,
    createdAt: campaign.createdAt,
  };
}

router.get(
  '/campaigns',
  asyncHandler(async (req, res) => {
    const items = await prisma.campaign.findMany({
      where: { tenantId: req.auth.tenantId },
      include: { createdBy: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ items: items.map(serialize) });
  })
);

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  integrationId: z.string().uuid().optional(),
  templateName: z.string().min(1),
  templateLanguage: z.string().default('es'),
  components: z.array(z.any()).optional(),
  recipients: z.object({
    contactIds: z.array(z.string().uuid()).optional(),
    tags: z.array(z.string()).optional(),
    all: z.boolean().optional(),
  }),
  scheduledAt: z.string().datetime().optional(),
});

/** Vista previa del segmento antes de crear: cuántos contactos entrarían. */
router.post(
  '/campaigns/preview',
  asyncHandler(async (req, res) => {
    const { recipients } = z.object({ recipients: createSchema.shape.recipients }).parse(req.body);
    const contacts = await selectContacts({ tenantId: req.auth.tenantId, ...recipients });
    res.json({ count: contacts.length, sample: contacts.slice(0, 5).map((c) => ({ id: c.id, name: c.name, waId: c.waId })) });
  })
);

router.post(
  '/campaigns',
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    const campaign = await createCampaign({ tenantId: req.auth.tenantId, userId: req.auth.userId, input });
    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: 'campaign.create',
      entity: 'campaign',
      entityId: campaign.id,
      metadata: { name: campaign.name, total: campaign.totalRecipients },
    });
    res.status(201).json(serialize(campaign));
  })
);

router.get(
  '/campaigns/:id',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, tenantId: req.auth.tenantId },
      include: { createdBy: { select: { id: true, name: true } } },
    });
    if (!campaign) throw notFound('Campaña no encontrada');
    const fresh = await refreshCampaignCounters(campaign.id);
    res.json(serialize({ ...fresh, createdBy: campaign.createdBy }));
  })
);

router.get(
  '/campaigns/:id/recipients',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, tenantId: req.auth.tenantId } });
    if (!campaign) throw notFound('Campaña no encontrada');
    const where = { campaignId: campaign.id };
    if (req.query.status) where.status = String(req.query.status);
    const items = await prisma.campaignRecipient.findMany({
      where,
      include: { contact: { select: { id: true, name: true, waId: true } } },
      orderBy: { createdAt: 'asc' },
      take: Math.min(Number(req.query.limit ?? 200), 1000),
      skip: Number(req.query.offset ?? 0),
    });
    res.json({ items });
  })
);

router.post(
  '/campaigns/:id/start',
  asyncHandler(async (req, res) => {
    res.json(serialize(await startCampaign({ tenantId: req.auth.tenantId, campaignId: req.params.id })));
  })
);

router.post(
  '/campaigns/:id/pause',
  asyncHandler(async (req, res) => {
    res.json(serialize(await pauseCampaign({ tenantId: req.auth.tenantId, campaignId: req.params.id })));
  })
);

router.post(
  '/campaigns/:id/cancel',
  asyncHandler(async (req, res) => {
    res.json(serialize(await cancelCampaign({ tenantId: req.auth.tenantId, campaignId: req.params.id })));
  })
);

export default router;
