import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/http.js';
import { badRequest } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { listTemplates } from '../../whatsapp/templates.js';
import { metaCredentials } from '../../whatsapp/credentials.js';

const router = Router();
router.use(requireAuth);

const VALID = new Set(['approved', 'rejected', 'paused', 'disabled']);
const normalize = (status) => (VALID.has(status) ? status : 'pending');

/** Los agentes necesitan leer las plantillas para enviarlas desde la bandeja. */
router.get(
  '/templates',
  asyncHandler(async (req, res) => {
    const where = { tenantId: req.auth.tenantId };
    if (req.query.status) where.status = String(req.query.status);
    const items = await prisma.template.findMany({ where, orderBy: [{ status: 'asc' }, { name: 'asc' }] });
    res.json({ items });
  })
);

/** Trae de Meta las plantillas de cada WABA activa y las guarda localmente. */
router.post(
  '/templates/sync',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const integrations = await prisma.metaIntegration.findMany({
      where: { tenantId: req.auth.tenantId, active: true },
    });
    if (integrations.length === 0) throw badRequest('No hay números conectados que sincronizar');

    const seen = new Set();
    let synced = 0;
    const seenNames = new Set();

    for (const integration of integrations) {
      if (seen.has(integration.wabaId)) continue;
      seen.add(integration.wabaId);

      const templates = await listTemplates(integration.wabaId, metaCredentials(integration));

      for (const template of templates) {
        const status = normalize(String(template.status ?? 'PENDING').toLowerCase());
        const key = `${template.name}::${template.language}`;
        seenNames.add(key);
        await prisma.template.upsert({
          where: { tenantId_name_language: { tenantId: req.auth.tenantId, name: template.name, language: template.language } },
          update: {
            wabaId: integration.wabaId,
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
    }

    res.json({ synced });
  })
);

export default router;
