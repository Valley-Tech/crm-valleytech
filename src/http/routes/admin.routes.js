import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { asyncHandler } from '../../lib/http.js';
import { badRequest, notFound, conflict } from '../../lib/errors.js';
import { encryptSecret, decryptSecret, generateApiKey } from '../../lib/crypto.js';
import { hashPassword } from '../../lib/password.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAudit } from '../../services/audit.js';
import { usageSummary } from '../../services/usage.js';
import { listTemplates } from '../../whatsapp/templates.js';
import {
  exchangeCodeForToken,
  debugToken,
  subscribeAppToWaba,
  registerPhoneNumber,
  getPhoneNumber,
} from '../../whatsapp/embeddedSignup.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

// ===========================================================================
//  Integraciones de Meta
// ===========================================================================

function serializeIntegration(integration) {
  // El token cifrado no sale nunca de la base de datos.
  return {
    id: integration.id,
    channel: integration.channel,
    wabaId: integration.wabaId,
    phoneNumberId: integration.phoneNumberId,
    displayPhoneNumber: integration.displayPhoneNumber,
    verifiedName: integration.verifiedName,
    qualityRating: integration.qualityRating,
    messagingTier: integration.messagingTier,
    isCoexistence: integration.isCoexistence,
    onboardingMethod: integration.onboardingMethod,
    active: integration.active,
    connectedAt: integration.connectedAt,
  };
}

router.get(
  '/integrations',
  asyncHandler(async (req, res) => {
    const items = await prisma.metaIntegration.findMany({
      where: { tenantId: req.auth.tenantId },
      orderBy: { connectedAt: 'asc' },
    });
    res.json({ items: items.map(serializeIntegration) });
  })
);

const manualSchema = z.object({
  wabaId: z.string().min(5),
  phoneNumberId: z.string().min(5),
  accessToken: z.string().min(20),
  displayPhoneNumber: z.string().optional(),
  isCoexistence: z.boolean().default(false),
  subscribe: z.boolean().default(true),
});

/**
 * Alta manual: el camino que funciona HOY, mientras Meta no apruebe la
 * revisión de la app. Pides al cliente su WABA ID, su Phone Number ID y un
 * token de usuario del sistema, y el CRM los guarda cifrados.
 */
router.post(
  '/integrations/meta',
  asyncHandler(async (req, res) => {
    const input = manualSchema.parse(req.body);

    const duplicate = await prisma.metaIntegration.findUnique({
      where: { phoneNumberId: input.phoneNumberId },
    });
    if (duplicate) throw conflict('phone_already_connected', 'Ese número ya está conectado a un cliente');

    // Se valida el token contra Meta antes de guardarlo: si no sirve, mejor
    // enterarse ahora que cuando llegue el primer mensaje.
    let phone;
    try {
      phone = await getPhoneNumber(input.phoneNumberId, input.accessToken);
    } catch (err) {
      throw badRequest(`Meta rechazó las credenciales: ${err.message}`);
    }

    if (input.subscribe) {
      try {
        await subscribeAppToWaba(input.wabaId, input.accessToken);
      } catch (err) {
        logger.warn({ err: err.message }, 'No se pudo suscribir la app a la WABA');
      }
    }

    const integration = await prisma.metaIntegration.create({
      data: {
        tenantId: req.auth.tenantId,
        wabaId: input.wabaId,
        phoneNumberId: input.phoneNumberId,
        displayPhoneNumber: input.displayPhoneNumber ?? phone?.display_phone_number ?? '',
        verifiedName: phone?.verified_name ?? null,
        qualityRating: phone?.quality_rating ?? null,
        messagingTier: phone?.messaging_limit_tier ?? null,
        accessTokenEnc: encryptSecret(input.accessToken),
        isCoexistence: input.isCoexistence,
        onboardingMethod: 'manual',
      },
    });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: 'integration.create',
      entity: 'meta_integration',
      entityId: integration.id,
      metadata: { phoneNumberId: input.phoneNumberId, method: 'manual' },
    });

    res.status(201).json(serializeIntegration(integration));
  })
);

/**
 * Registro insertado. Queda listo para el día en que Meta apruebe la revisión:
 * el frontend abre el diálogo del SDK y manda aquí el código resultante.
 */
router.post(
  '/integrations/meta/embedded-signup',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        code: z.string().min(10),
        wabaId: z.string().optional(),
        phoneNumberId: z.string().optional(),
      })
      .parse(req.body);

    const tokenResponse = await exchangeCodeForToken(input.code);
    const accessToken = tokenResponse?.access_token;
    if (!accessToken) throw badRequest('Meta no devolvió un access token para ese código');

    const info = await debugToken(accessToken);
    const wabaId =
      input.wabaId ??
      info?.granular_scopes?.find((scope) => scope.scope === 'whatsapp_business_management')
        ?.target_ids?.[0];

    if (!wabaId) throw badRequest('No se pudo determinar la WABA del cliente');

    const phoneNumberId = input.phoneNumberId;
    if (!phoneNumberId) throw badRequest('Falta phoneNumberId');

    await subscribeAppToWaba(wabaId, accessToken);
    const phone = await getPhoneNumber(phoneNumberId, accessToken);

    const integration = await prisma.metaIntegration.upsert({
      where: { phoneNumberId },
      update: {
        tenantId: req.auth.tenantId,
        wabaId,
        accessTokenEnc: encryptSecret(accessToken),
        displayPhoneNumber: phone?.display_phone_number ?? '',
        verifiedName: phone?.verified_name ?? null,
        active: true,
        onboardingMethod: 'embedded_signup',
      },
      create: {
        tenantId: req.auth.tenantId,
        wabaId,
        phoneNumberId,
        displayPhoneNumber: phone?.display_phone_number ?? '',
        verifiedName: phone?.verified_name ?? null,
        accessTokenEnc: encryptSecret(accessToken),
        onboardingMethod: 'embedded_signup',
      },
    });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: 'integration.create',
      entity: 'meta_integration',
      entityId: integration.id,
      metadata: { phoneNumberId, method: 'embedded_signup' },
    });

    res.status(201).json(serializeIntegration(integration));
  })
);

/** Registra el número en la Cloud API con el PIN de verificación en dos pasos. */
router.post(
  '/integrations/:id/register',
  asyncHandler(async (req, res) => {
    const { pin } = z.object({ pin: z.string().regex(/^\d{6}$/, 'El PIN son 6 dígitos') }).parse(req.body);

    const integration = await prisma.metaIntegration.findFirst({
      where: { id: req.params.id, tenantId: req.auth.tenantId },
    });
    if (!integration) throw notFound('Integración no encontrada');

    const result = await registerPhoneNumber(
      integration.phoneNumberId,
      decryptSecret(integration.accessTokenEnc),
      pin
    );
    res.json({ ok: true, result });
  })
);

router.patch(
  '/integrations/:id',
  asyncHandler(async (req, res) => {
    const data = z.object({ active: z.boolean() }).parse(req.body);
    const integration = await prisma.metaIntegration.findFirst({
      where: { id: req.params.id, tenantId: req.auth.tenantId },
    });
    if (!integration) throw notFound('Integración no encontrada');

    const updated = await prisma.metaIntegration.update({ where: { id: integration.id }, data });
    res.json(serializeIntegration(updated));
  })
);

// ===========================================================================
//  Plantillas
// ===========================================================================

router.get(
  '/templates',
  asyncHandler(async (req, res) => {
    const items = await prisma.template.findMany({
      where: { tenantId: req.auth.tenantId },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
    res.json({ items });
  })
);

/** Trae de Meta las plantillas aprobadas y las guarda localmente. */
router.post(
  '/templates/sync',
  asyncHandler(async (req, res) => {
    const integrations = await prisma.metaIntegration.findMany({
      where: { tenantId: req.auth.tenantId, active: true },
    });
    if (integrations.length === 0) throw badRequest('No hay integraciones activas que sincronizar');

    const seenWabas = new Set();
    let synced = 0;

    for (const integration of integrations) {
      if (seenWabas.has(integration.wabaId)) continue;
      seenWabas.add(integration.wabaId);

      const accessToken = decryptSecret(integration.accessTokenEnc);
      const templates = await listTemplates(integration.wabaId, accessToken);

      for (const template of templates) {
        const status = String(template.status ?? 'PENDING').toLowerCase();
        await prisma.template.upsert({
          where: {
            tenantId_name_language: {
              tenantId: req.auth.tenantId,
              name: template.name,
              language: template.language,
            },
          },
          update: {
            wabaId: integration.wabaId,
            metaTemplateId: template.id,
            category: template.category ?? 'UTILITY',
            status: ['approved', 'rejected', 'paused', 'disabled'].includes(status) ? status : 'pending',
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
            status: ['approved', 'rejected', 'paused', 'disabled'].includes(status) ? status : 'pending',
            components: template.components ?? undefined,
          },
        });
        synced += 1;
      }
    }

    res.json({ synced });
  })
);

// ===========================================================================
//  Chatbots conectados (Bot Gateway)
// ===========================================================================

function serializeBot(bot) {
  return {
    id: bot.id,
    name: bot.name,
    channel: bot.channel,
    endpointUrl: bot.endpointUrl,
    apiKeyPrefix: bot.apiKeyPrefix,
    active: bot.active,
    lastDispatchAt: bot.lastDispatchAt,
    createdAt: bot.createdAt,
  };
}

router.get(
  '/bots',
  asyncHandler(async (req, res) => {
    const items = await prisma.botIntegration.findMany({
      where: { tenantId: req.auth.tenantId },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ items: items.map(serializeBot) });
  })
);

/**
 * Da de alta un chatbot. Devuelve la API key y el secreto de firma UNA sola
 * vez: en base de datos solo queda el hash de la key y el secreto cifrado.
 */
router.post(
  '/bots',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        name: z.string().min(2).max(80),
        endpointUrl: z.string().url(),
        channel: z.enum(['whatsapp', 'instagram']).default('whatsapp'),
      })
      .parse(req.body);

    const apiKey = generateApiKey('vtk');
    const signingSecret = crypto.randomBytes(32).toString('base64url');

    const bot = await prisma.botIntegration.create({
      data: {
        tenantId: req.auth.tenantId,
        name: input.name,
        channel: input.channel,
        endpointUrl: input.endpointUrl,
        signingSecret: encryptSecret(signingSecret),
        apiKeyHash: apiKey.hash,
        apiKeyPrefix: apiKey.prefix,
      },
    });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: 'bot.create',
      entity: 'bot_integration',
      entityId: bot.id,
      metadata: { name: bot.name },
    });

    res.status(201).json({
      ...serializeBot(bot),
      credentials: {
        apiKey: apiKey.raw,
        signingSecret,
        aviso: 'Guárdalos ahora: no se vuelven a mostrar.',
      },
    });
  })
);

router.post(
  '/bots/:id/rotate-key',
  asyncHandler(async (req, res) => {
    const bot = await prisma.botIntegration.findFirst({
      where: { id: req.params.id, tenantId: req.auth.tenantId },
    });
    if (!bot) throw notFound('Bot no encontrado');

    const apiKey = generateApiKey('vtk');
    const signingSecret = crypto.randomBytes(32).toString('base64url');

    const updated = await prisma.botIntegration.update({
      where: { id: bot.id },
      data: { apiKeyHash: apiKey.hash, apiKeyPrefix: apiKey.prefix, signingSecret: encryptSecret(signingSecret) },
    });

    res.json({
      ...serializeBot(updated),
      credentials: { apiKey: apiKey.raw, signingSecret, aviso: 'Guárdalos ahora: no se vuelven a mostrar.' },
    });
  })
);

router.patch(
  '/bots/:id',
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        name: z.string().min(2).max(80).optional(),
        endpointUrl: z.string().url().optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body);

    const bot = await prisma.botIntegration.findFirst({
      where: { id: req.params.id, tenantId: req.auth.tenantId },
    });
    if (!bot) throw notFound('Bot no encontrado');

    res.json(serializeBot(await prisma.botIntegration.update({ where: { id: bot.id }, data })));
  })
);

router.delete(
  '/bots/:id',
  asyncHandler(async (req, res) => {
    const bot = await prisma.botIntegration.findFirst({
      where: { id: req.params.id, tenantId: req.auth.tenantId },
    });
    if (!bot) throw notFound('Bot no encontrado');

    await prisma.botIntegration.delete({ where: { id: bot.id } });
    res.status(204).send();
  })
);

// ===========================================================================
//  Usuarios del cliente
// ===========================================================================

router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const items = await prisma.user.findMany({
      where: { tenantId: req.auth.tenantId },
      select: { id: true, name: true, email: true, role: true, active: true, lastLoginAt: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ items });
  })
);

router.post(
  '/users',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        name: z.string().min(2).max(80),
        email: z.string().email(),
        password: z.string().min(10, 'La contraseña debe tener al menos 10 caracteres'),
        role: z.enum(['owner', 'admin', 'agent', 'viewer']).default('agent'),
      })
      .parse(req.body);

    const user = await prisma.user.create({
      data: {
        tenantId: req.auth.tenantId,
        name: input.name,
        email: input.email.toLowerCase(),
        passwordHash: await hashPassword(input.password),
        role: input.role,
      },
      select: { id: true, name: true, email: true, role: true, active: true },
    });

    res.status(201).json(user);
  })
);

// ===========================================================================
//  Consumo
// ===========================================================================

router.get(
  '/usage/summary',
  asyncHandler(async (req, res) => {
    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);

    const from = req.query.from ? new Date(String(req.query.from)) : defaultFrom;
    const to = req.query.to ? new Date(String(req.query.to)) : now;

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw badRequest('Fechas inválidas: usa formato ISO (2026-09-01)');
    }

    res.json({
      from,
      to,
      items: await usageSummary({ tenantId: req.auth.tenantId, from, to }),
    });
  })
);

export default router;
