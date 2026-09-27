import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/http.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { listTemplates, createTemplate, deleteTemplate, uploadTemplateExample } from '../../whatsapp/templates.js';
import { metaCredentials } from '../../whatsapp/credentials.js';
import { templateWhere, metaIntegrationWhere, canSeeIntegration } from '../../services/access.js';
import { recordAudit } from '../../services/audit.js';
import { buildTemplateComponents, templateDraftSchema } from '../../services/templateBuilder.js';

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

// ---------------------------------------------------------------------------
//  Crear y eliminar plantillas desde el CRM (como en el WhatsApp Manager)
// ---------------------------------------------------------------------------

/** Número visible por el usuario, con sus credenciales de Meta. */
async function integrationInScope(req, integrationId) {
  if (!canSeeIntegration(req.auth.scope, integrationId)) throw forbidden('Ese número no está entre los que administras');
  const integration = await prisma.metaIntegration.findFirst({ where: { id: integrationId, tenantId: req.auth.tenantId, active: true } });
  if (!integration) throw badRequest('Número no encontrado o inactivo');
  return integration;
}

const exampleUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
const EXAMPLE_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'video/mp4', 'application/pdf']);

/**
 * Archivo de ejemplo para una cabecera de imagen, video o documento. Meta lo
 * exige para revisar la plantilla; devuelve el "handle" que va en el borrador.
 */
router.post(
  '/templates/example',
  requireRole('owner'),
  exampleUpload.single('file'),
  asyncHandler(async (req, res) => {
    const integrationId = String(req.body?.integrationId ?? '');
    if (!integrationId) throw badRequest('Indica integrationId');
    if (!req.file) throw badRequest('Adjunta el archivo en el campo "file"');
    if (!EXAMPLE_MIME.has(req.file.mimetype)) throw badRequest('Formato no admitido: usa JPG, PNG, MP4 o PDF');
    const integration = await integrationInScope(req, integrationId);
    const credentials = metaCredentials(integration);
    const { handle } = await uploadTemplateExample({
      appId: credentials.appId,
      accessToken: credentials,
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      filename: req.file.originalname,
    });
    res.status(201).json({ handle, name: req.file.originalname, mimeType: req.file.mimetype, sizeBytes: req.file.size });
  })
);

/** Vista previa del JSON que se mandaría a Meta (para depurar sin crear nada). */
router.post(
  '/templates/preview',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const draft = templateDraftSchema.parse(req.body);
    res.json(buildTemplateComponents(draft));
  })
);

/** Crea la plantilla en Meta (queda pendiente de revisión) y la guarda localmente. */
router.post(
  '/templates',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const draft = templateDraftSchema.parse(req.body);
    const integration = await integrationInScope(req, draft.integrationId);
    const payload = buildTemplateComponents(draft);

    const exists = await prisma.template.findFirst({
      where: { tenantId: req.auth.tenantId, wabaId: integration.wabaId, name: payload.name, language: payload.language },
      select: { id: true },
    });
    if (exists) throw badRequest(`Ya existe la plantilla "${payload.name}" en ${payload.language} para este número`);

    const created = await createTemplate(integration.wabaId, metaCredentials(integration), payload);
    const status = String(created?.status ?? 'PENDING').toLowerCase();

    const template = await prisma.template.upsert({
      where: { tenantId_wabaId_name_language: { tenantId: req.auth.tenantId, wabaId: integration.wabaId, name: payload.name, language: payload.language } },
      update: { metaTemplateId: created?.id ?? null, category: created?.category ?? payload.category, status: VALID.has(status) ? status : 'pending', components: payload.components, syncedAt: new Date() },
      create: {
        tenantId: req.auth.tenantId,
        wabaId: integration.wabaId,
        metaTemplateId: created?.id ?? null,
        name: payload.name,
        language: payload.language,
        category: created?.category ?? payload.category,
        status: VALID.has(status) ? status : 'pending',
        components: payload.components,
      },
    });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: 'template.create',
      entity: 'template',
      entityId: template.id,
      metadata: { name: payload.name, language: payload.language, category: payload.category, integration: integration.displayPhoneNumber },
    });

    res.status(201).json({
      ...template,
      numbers: [{ id: integration.id, displayPhoneNumber: integration.displayPhoneNumber, verifiedName: integration.verifiedName, active: integration.active }],
      metaCategory: created?.category ?? null,
    });
  })
);

/** Elimina la plantilla en Meta y en el CRM (solo esa variante de idioma). */
router.delete(
  '/templates/:id',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const template = await prisma.template.findFirst({ where: { id: req.params.id, tenantId: req.auth.tenantId, ...templateWhere(req.auth.scope) } });
    if (!template) throw notFound('Plantilla no encontrada');
    const integration = await prisma.metaIntegration.findFirst({
      where: { tenantId: req.auth.tenantId, wabaId: template.wabaId, active: true, ...metaIntegrationWhere(req.auth.scope) },
      orderBy: { connectedAt: 'asc' },
    });
    if (!integration) throw badRequest('No hay un número activo de esa cuenta para pedirle a Meta que la elimine');

    await deleteTemplate(integration.wabaId, metaCredentials(integration), { name: template.name, id: template.metaTemplateId ?? undefined });
    // Sin id de Meta, el borrado por nombre se lleva todos los idiomas: se reflejan igual aquí.
    const where = template.metaTemplateId
      ? { id: template.id }
      : { tenantId: req.auth.tenantId, wabaId: template.wabaId, name: template.name };
    const result = await prisma.template.deleteMany({ where });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: 'template.delete',
      entity: 'template',
      entityId: template.id,
      metadata: { name: template.name, language: template.language, deleted: result.count },
    });
    res.json({ ok: true, deleted: result.count });
  })
);

export default router;
