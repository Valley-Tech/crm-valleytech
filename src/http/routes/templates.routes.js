import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/http.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { listTemplates } from '../../whatsapp/templates.js';
import { metaCredentials } from '../../whatsapp/credentials.js';
import { templateWhere, metaIntegrationWhere, canSeeIntegration } from '../../services/access.js';

/**
 * Plantillas de WhatsApp. Pertenecen a la WABA de cada número, así que cada
 * dueño ve (y sincroniza) solo las de sus números; el superadmin ve todas y
 * puede filtrarlas por número con ?integrationId=.
 */

const router = Router();
router.use(requireAuth);

const VALID = new Set(['approved', 'rejected', 'paused', 'disabled']);
const normalize = (status) => (VALID.has(status) ? status : 'pending');

/** Números visibles, agrupados por WABA, con el chatbot que los atiende. */
async function numbersByWaba(req) {
  const integrations = await prisma.metaIntegration.findMany({
    where: { tenantId: req.auth.tenantId, ...metaIntegrationWhere(req.auth.scope) },
    select: { id: true, wabaId: true, displayPhoneNumber: true, verifiedName: true, active: true, bots: { where: { active: true }, select: { id: true, name: true } } },
    orderBy: { connectedAt: 'asc' },
  });
  const map = new Map();
  for (const i of integrations) {
    if (!map.has(i.wabaId)) map.set(i.wabaId, []);
    map.get(i.wabaId).push({ id: i.id, displayPhoneNumber: i.displayPhoneNumber, verifiedName: i.verifiedName, active: i.active, bots: i.bots });
  }
  return { integrations, map };
}

/** Los agentes necesitan leer las plantillas para enviarlas desde la bandeja. */
router.get(
  '/templates',
  asyncHandler(async (req, res) => {
    const where = { tenantId: req.auth.tenantId, ...templateWhere(req.auth.scope) };
    if (req.query.status) where.status = String(req.query.status);

    const { integrations, map } = await numbersByWaba(req);
    if (req.query.integrationId) {
      const integrationId = String(req.query.integrationId);
      if (!canSeeIntegration(req.auth.scope, integrationId)) throw forbidden('Ese número no está entre los que administras');
      const integration = integrations.find((i) => i.id === integrationId);
      if (!integration) throw badRequest('Número no encontrado');
      where.wabaId = integration.wabaId;
    }

    const items = await prisma.template.findMany({ where, orderBy: [{ status: 'asc' }, { name: 'asc' }] });
    res.json({ items: items.map((t) => ({ ...t, numbers: map.get(t.wabaId) ?? [] })) });
  })
);

/**
 * Trae de Meta las plantillas de cada WABA visible y las guarda localmente.
 * Un dueño sincroniza solo las de sus números; ?integrationId= limita a uno.
 */
router.post(
  '/templates/sync',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const where = { tenantId: req.auth.tenantId, active: true, ...metaIntegrationWhere(req.auth.scope) };
    const only = req.query.integrationId ? String(req.query.integrationId) : req.body?.integrationId;
    if (only) {
      if (!canSeeIntegration(req.auth.scope, only)) throw forbidden('Ese número no está entre los que administras');
      where.id = only;
    }
    const integrations = await prisma.metaIntegration.findMany({ where });
    if (integrations.length === 0) throw badRequest('No hay números conectados que sincronizar');

    const seen = new Set();
    let synced = 0;
    let removed = 0;

    for (const integration of integrations) {
      if (seen.has(integration.wabaId)) continue;
      seen.add(integration.wabaId);

      const templates = await listTemplates(integration.wabaId, metaCredentials(integration));
      const keep = new Set();

      for (const template of templates) {
        const status = normalize(String(template.status ?? 'PENDING').toLowerCase());
        keep.add(`${template.name}::${template.language}`);
        await prisma.template.upsert({
          where: {
            tenantId_wabaId_name_language: { tenantId: req.auth.tenantId, wabaId: integration.wabaId, name: template.name, language: template.language },
          },
          update: {
            metaTemplateId: template.id,
            category: template.category ?? 'UTILITY',
            status,
            components: template.components ?? undefined,
            syncedAt: new Date(),
          },
          create: {
            tenantId: req.auth.tenantId,
            wabaId: integration.wabaId,
            metaTemplateId: template.id,
            name: template.name,
            language: template.language,
            category: template.category ?? 'UTILITY',
            status,
            components: template.components ?? undefined,
          },
        });
        synced += 1;
      }

      // Las que Meta ya no devuelve (borradas en el WhatsApp Manager) se quitan.
      const local = await prisma.template.findMany({ where: { tenantId: req.auth.tenantId, wabaId: integration.wabaId }, select: { id: true, name: true, language: true } });
      const stale = local.filter((t) => !keep.has(`${t.name}::${t.language}`)).map((t) => t.id);
      if (stale.length) {
        const r = await prisma.template.deleteMany({ where: { id: { in: stale } } });
        removed += r.count;
      }
    }

    res.json({ synced, removed, wabas: seen.size });
  })
);

export default router;
