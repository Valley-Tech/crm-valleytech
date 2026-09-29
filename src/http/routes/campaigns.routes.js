import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/http.js';
import { notFound, forbidden, badRequest } from '../../lib/errors.js';
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
import { integrationWhere, canSeeIntegration } from '../../services/access.js';
import { validateTemplateComponents, templateSpec } from '../../services/templateParams.js';

/**
 * Campañas. Cada una sale por un número concreto (integrationId) y usa una
 * plantilla de la WABA de ese número. Un dueño solo ve y crea campañas de sus
 * números, y sus destinatarios salen de los contactos de esos números.
 */

const router = Router();
router.use(requireAuth, requireRole('owner'));

const campaignInclude = {
  createdBy: { select: { id: true, name: true } },
  integration: { select: { id: true, displayPhoneNumber: true, verifiedName: true, active: true, bots: { where: { active: true }, select: { id: true, name: true } } } },
};

async function loadCampaign(req) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: req.params.id, tenantId: req.auth.tenantId, ...integrationWhere(req.auth.scope) },
    include: campaignInclude,
  });
  if (!campaign) throw notFound('Campaña no encontrada');
  return campaign;
}

function serialize(campaign) {
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    templateName: campaign.templateName,
    templateLanguage: campaign.templateLanguage,
    components: campaign.components,
    integrationId: campaign.integrationId,
    integration: campaign.integration
      ? { id: campaign.integration.id, displayPhoneNumber: campaign.integration.displayPhoneNumber, verifiedName: campaign.integration.verifiedName, active: campaign.integration.active, bots: campaign.integration.bots }
      : null,
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
    const where = { tenantId: req.auth.tenantId, ...integrationWhere(req.auth.scope) };
    if (req.query.integrationId) {
      if (!canSeeIntegration(req.auth.scope, String(req.query.integrationId))) throw forbidden('Ese número no está entre los que administras');
      where.integrationId = String(req.query.integrationId);
    }
    const items = await prisma.campaign.findMany({
      where,
      include: campaignInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ items: items.map(serialize) });
  })
);

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  integrationId: z.string().uuid(),
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

/**
 * Validación completa antes de crear: plantilla existente y aprobada en la
 * WABA del número, parámetros que cuadran con la plantilla, sin caracteres
 * que Meta rechaza y sin campos de contacto vacíos. Devuelve la lista de
 * problemas para mostrarla en el formulario; con lista vacía se puede crear.
 */
router.post(
  '/campaigns/validate',
  asyncHandler(async (req, res) => {
    const input = createSchema.partial({ name: true, recipients: true }).extend({ recipients: createSchema.shape.recipients.optional() }).parse(req.body);
    const problems = [];
    if (!canSeeIntegration(req.auth.scope, input.integrationId)) throw forbidden('Ese número no está entre los que administras');
    const integration = await prisma.metaIntegration.findFirst({ where: { id: input.integrationId, tenantId: req.auth.tenantId, active: true } });
    if (!integration) problems.push('El número que envía no existe o está inactivo.');

    let template = null;
    let spec = null;
    if (integration) {
      template = await prisma.template.findFirst({ where: { tenantId: req.auth.tenantId, wabaId: integration.wabaId, name: input.templateName, language: input.templateLanguage ?? 'es' } });
      if (!template) problems.push(`La plantilla "${input.templateName}" (${input.templateLanguage ?? 'es'}) no existe para el número ${integration.displayPhoneNumber}. Sincroniza las plantillas de ese número o revisa el nombre.`);
      else if (template.status !== 'approved') problems.push(`La plantilla "${template.name}" no está aprobada (estado: ${template.status}).`);
    }

    let contacts = [];
    if (input.recipients) {
      contacts = await selectContacts({ tenantId: req.auth.tenantId, scope: req.auth.scope, integrationId: input.integrationId, ...input.recipients }).catch(() => []);
      if (contacts.length === 0) problems.push('El segmento elegido no tiene contactos.');
    }
    if (template) {
      const check = validateTemplateComponents(template, input.components ?? [], { contacts });
      problems.push(...check.problems);
      spec = check.spec;
    }
    res.json({ ok: problems.length === 0, problems, spec: spec ?? (template ? templateSpec(template) : null), recipients: contacts.length });
  })
);

/** Vista previa del segmento antes de crear: cuántos contactos entrarían. */
router.post(
  '/campaigns/preview',
  asyncHandler(async (req, res) => {
    const { recipients, integrationId } = z.object({ recipients: createSchema.shape.recipients, integrationId: z.string().uuid().optional() }).parse(req.body);
    if (integrationId && !canSeeIntegration(req.auth.scope, integrationId)) throw forbidden('Ese número no está entre los que administras');
    const contacts = await selectContacts({ tenantId: req.auth.tenantId, scope: req.auth.scope, integrationId, ...recipients });
    res.json({ count: contacts.length, sample: contacts.slice(0, 5).map((c) => ({ id: c.id, name: c.name, waId: c.waId })) });
  })
);

router.post(
  '/campaigns',
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    if (!canSeeIntegration(req.auth.scope, input.integrationId)) throw forbidden('Ese número no está entre los que administras');
    const campaign = await createCampaign({ tenantId: req.auth.tenantId, userId: req.auth.userId, scope: req.auth.scope, input });
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
    const campaign = await loadCampaign(req);
    const fresh = await refreshCampaignCounters(campaign.id);
    res.json(serialize({ ...fresh, createdBy: campaign.createdBy, integration: campaign.integration }));
  })
);

router.get(
  '/campaigns/:id/recipients',
  asyncHandler(async (req, res) => {
    const campaign = await loadCampaign(req);
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
    const campaign = await loadCampaign(req);
    res.json(serialize({ ...(await startCampaign({ tenantId: req.auth.tenantId, campaignId: campaign.id })), createdBy: campaign.createdBy, integration: campaign.integration }));
  })
);

router.post(
  '/campaigns/:id/pause',
  asyncHandler(async (req, res) => {
    const campaign = await loadCampaign(req);
    res.json(serialize({ ...(await pauseCampaign({ tenantId: req.auth.tenantId, campaignId: campaign.id })), createdBy: campaign.createdBy, integration: campaign.integration }));
  })
);

router.post(
  '/campaigns/:id/cancel',
  asyncHandler(async (req, res) => {
    const campaign = await loadCampaign(req);
    res.json(serialize({ ...(await cancelCampaign({ tenantId: req.auth.tenantId, campaignId: campaign.id })), createdBy: campaign.createdBy, integration: campaign.integration }));
  })
);

export default router;
