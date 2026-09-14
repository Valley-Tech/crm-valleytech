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
import {
  exchangeCodeForToken,
  debugToken,
  subscribeAppToWaba,
  registerPhoneNumber,
  getPhoneNumber,
} from '../../whatsapp/embeddedSignup.js';
import { metaCredentials } from '../../whatsapp/credentials.js';
import { diagnoseIntegration } from '../../services/integrationDiagnostics.js';
import { webhookDiagnostics } from '../../services/webhookDiagnostics.js';
import { invalidateWebhookSecrets } from '../../services/webhookSecrets.js';
import env from '../../config/env.js';

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
    echoPausesBot: integration.echoPausesBot,
    active: integration.active,
    connectedAt: integration.connectedAt,
    // App de Meta dueña del token: la del CRM salvo que la integración tenga la suya.
    metaAppId: integration.metaAppId ?? env.META_APP_ID,
    ownApp: !integration.metaAppSecretEnc,
    lastWebhookAt: integration.lastWebhookAt,
    lastInboundAt: integration.lastInboundAt,
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
  // Solo si el token NO se generó para la app del CRM (META_APP_ID).
  metaAppId: z.string().trim().optional().or(z.literal('')),
  metaAppSecret: z.string().trim().optional().or(z.literal('')),
});

function ownAppFields(input) {
  const appId = input.metaAppId || null;
  const appSecret = input.metaAppSecret || null;
  if ((appId && !appSecret) || (!appId && appSecret)) {
    throw badRequest('Indica el App ID y el App Secret juntos, o ninguno de los dos');
  }
  if (appId && appId === env.META_APP_ID) return { metaAppId: null, metaAppSecretEnc: null };
  return { metaAppId: appId, metaAppSecretEnc: appSecret ? encryptSecret(appSecret) : null };
}

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
    const ownApp = ownAppFields(input);
    const credentials = {
      accessToken: input.accessToken,
      appId: ownApp.metaAppId ?? env.META_APP_ID,
      appSecret: input.metaAppSecret || env.META_APP_SECRET,
    };

    let phone;
    try {
      phone = await getPhoneNumber(input.phoneNumberId, credentials);
    } catch (err) {
      throw badRequest(`Meta rechazó las credenciales: ${err.message}`);
    }

    let subscribed = null;
    if (input.subscribe) {
      try {
        await subscribeAppToWaba(input.wabaId, credentials);
        subscribed = true;
      } catch (err) {
        subscribed = false;
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
        ...ownApp,
      },
    });
    invalidateWebhookSecrets();

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: 'integration.create',
      entity: 'meta_integration',
      entityId: integration.id,
      metadata: { phoneNumberId: input.phoneNumberId, method: 'manual' },
    });

    res.status(201).json({ ...serializeIntegration(integration), subscribed });
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
        // true cuando el diálogo terminó con FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING:
        // el cliente conectó un número que ya usa en la app de WhatsApp Business.
        coexistence: z.boolean().default(false),
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
        qualityRating: phone?.quality_rating ?? null,
        messagingTier: phone?.messaging_limit_tier ?? null,
        active: true,
        isCoexistence: input.coexistence,
        syncStatus: input.coexistence ? 'pending' : 'not_applicable',
        onboardingMethod: 'embedded_signup',
      },
      create: {
        tenantId: req.auth.tenantId,
        wabaId,
        phoneNumberId,
        displayPhoneNumber: phone?.display_phone_number ?? '',
        verifiedName: phone?.verified_name ?? null,
        qualityRating: phone?.quality_rating ?? null,
        messagingTier: phone?.messaging_limit_tier ?? null,
        accessTokenEnc: encryptSecret(accessToken),
        isCoexistence: input.coexistence,
        syncStatus: input.coexistence ? 'pending' : 'not_applicable',
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

    const result = await registerPhoneNumber(integration.phoneNumberId, metaCredentials(integration), pin);
    res.json({ ok: true, result });
  })
);

/** Diagnóstico completo: token, suscripción a la WABA, webhook de la app y actividad. */
router.get(
  '/integrations/:id/diagnose',
  asyncHandler(async (req, res) => {
    const integration = await prisma.metaIntegration.findFirst({
      where: { id: req.params.id, tenantId: req.auth.tenantId },
    });
    if (!integration) throw notFound('Integración no encontrada');
    res.json(await diagnoseIntegration(integration));
  })
);

/** Vuelve a suscribir la app dueña del token a los webhooks de la WABA. */
router.post(
  '/integrations/:id/subscribe',
  asyncHandler(async (req, res) => {
    const integration = await prisma.metaIntegration.findFirst({
      where: { id: req.params.id, tenantId: req.auth.tenantId },
    });
    if (!integration) throw notFound('Integración no encontrada');
    try {
      const result = await subscribeAppToWaba(integration.wabaId, metaCredentials(integration));
      res.json({ ok: true, result });
    } catch (err) {
      throw badRequest(`Meta no aceptó la suscripción: ${err.message}`);
    }
  })
);

/** Reemplaza el token (y opcionalmente la app de Meta) de un número ya conectado. */
router.post(
  '/integrations/:id/credentials',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        accessToken: z.string().min(20).optional(),
        metaAppId: z.string().trim().optional().or(z.literal('')),
        metaAppSecret: z.string().trim().optional().or(z.literal('')),
      })
      .parse(req.body);
    const integration = await prisma.metaIntegration.findFirst({
      where: { id: req.params.id, tenantId: req.auth.tenantId },
    });
    if (!integration) throw notFound('Integración no encontrada');

    const ownApp = ownAppFields(input);
    const accessToken = input.accessToken ?? decryptSecret(integration.accessTokenEnc);
    const credentials = {
      accessToken,
      appId: ownApp.metaAppId ?? env.META_APP_ID,
      appSecret: input.metaAppSecret || env.META_APP_SECRET,
    };

    let phone;
    try {
      phone = await getPhoneNumber(integration.phoneNumberId, credentials);
    } catch (err) {
      throw badRequest(`Meta rechazó las credenciales: ${err.message}`);
    }

    const updated = await prisma.metaIntegration.update({
      where: { id: integration.id },
      data: {
        ...(input.accessToken ? { accessTokenEnc: encryptSecret(input.accessToken) } : {}),
        ...ownApp,
        displayPhoneNumber: phone?.display_phone_number ?? integration.displayPhoneNumber,
        verifiedName: phone?.verified_name ?? integration.verifiedName,
        qualityRating: phone?.quality_rating ?? integration.qualityRating,
        messagingTier: phone?.messaging_limit_tier ?? integration.messagingTier,
      },
    });
    invalidateWebhookSecrets();

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: 'integration.credentials',
      entity: 'meta_integration',
      entityId: integration.id,
      metadata: { phoneNumberId: integration.phoneNumberId, metaAppId: ownApp.metaAppId },
    });

    res.json(serializeIntegration(updated));
  })
);

/** Rastro global del webhook: último POST aceptado/rechazado y números desconocidos. */
router.get(
  '/integrations/webhook-status',
  asyncHandler(async (req, res) => {
    res.json({
      webhookUrl: `${env.PUBLIC_URL.replace(/\/$/, '')}/webhooks/meta`,
      appId: env.META_APP_ID,
      ...(await webhookDiagnostics()),
    });
  })
);

router.patch(
  '/integrations/:id',
  asyncHandler(async (req, res) => {
    const data = z
      .object({ active: z.boolean().optional(), echoPausesBot: z.boolean().optional() })
      .parse(req.body);
    const integration = await prisma.metaIntegration.findFirst({
      where: { id: req.params.id, tenantId: req.auth.tenantId },
    });
    if (!integration) throw notFound('Integración no encontrada');

    const updated = await prisma.metaIntegration.update({ where: { id: integration.id }, data });
    res.json(serializeIntegration(updated));
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
    metaIntegrationId: bot.metaIntegrationId ?? null,
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
        metaIntegrationId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body);

    if (input.metaIntegrationId) {
      const owned = await prisma.metaIntegration.findFirst({ where: { id: input.metaIntegrationId, tenantId: req.auth.tenantId } });
      if (!owned) throw badRequest('Ese número no pertenece a este cliente');
    }

    const apiKey = generateApiKey('vtk');
    const signingSecret = crypto.randomBytes(32).toString('base64url');

    const bot = await prisma.botIntegration.create({
      data: {
        tenantId: req.auth.tenantId,
        name: input.name,
        channel: input.channel,
        endpointUrl: input.endpointUrl,
        metaIntegrationId: input.metaIntegrationId ?? null,
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
        metaIntegrationId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body);

    if (data.metaIntegrationId) {
      const owned = await prisma.metaIntegration.findFirst({ where: { id: data.metaIntegrationId, tenantId: req.auth.tenantId } });
      if (!owned) throw badRequest('Ese número no pertenece a este cliente');
    }

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

router.patch(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        name: z.string().min(2).max(80).optional(),
        role: z.enum(['owner', 'admin', 'agent', 'viewer']).optional(),
        active: z.boolean().optional(),
        password: z.string().min(10).optional(),
      })
      .parse(req.body);

    const user = await prisma.user.findFirst({ where: { id: req.params.id, tenantId: req.auth.tenantId } });
    if (!user) throw notFound('Usuario no encontrado');

    // Nadie se quita a sí mismo el acceso ni el rol de dueño por accidente.
    if (user.id === req.auth.userId && (input.active === false || (input.role && input.role !== user.role))) {
      throw badRequest('No puedes cambiar tu propio rol ni desactivarte');
    }

    const { password, ...rest } = input;
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { ...rest, ...(password ? { passwordHash: await hashPassword(password) } : {}) },
      select: { id: true, name: true, email: true, role: true, active: true, lastLoginAt: true },
    });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: 'user.update',
      entity: 'user',
      entityId: user.id,
      metadata: rest,
    });

    res.json(updated);
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
