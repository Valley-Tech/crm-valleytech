import prisma from '../db/prisma.js';

/**
 * Todo webhook de WhatsApp incluye el phone_number_id en metadata. Como es
 * multi-tenant, ese es el dato que usamos para saber a qué cliente pertenece
 * el evento antes de procesarlo, y así evitar mezclar datos entre tenants.
 */
export async function resolveTenantFromWebhook(req, res, next) {
  try {
    const entry = req.metaBody?.entry?.[0];
    const change = entry?.changes?.[0];
    const phoneNumberId = change?.value?.metadata?.phone_number_id;

    if (!phoneNumberId) {
      // Algunos eventos (ej. ciertos account_update) pueden no traer metadata.phone_number_id;
      // en ese caso se resuelve por waba_id (entry.id) más adelante en el controller.
      req.tenantContext = { phoneNumberId: null, wabaId: entry?.id ?? null };
      return next();
    }

    const integration = await prisma.metaIntegration.findUnique({
      where: { phoneNumberId },
      include: { tenant: true },
    });

    if (!integration) {
      // Evento de un número que no reconocemos: respondemos 200 igual (Meta
      // reintenta si no le das 200) pero no seguimos procesando.
      return res.sendStatus(200);
    }

    req.tenantContext = {
      tenantId: integration.tenantId,
      phoneNumberId,
      accessTokenEnc: integration.accessTokenEnc,
      isCoexistence: integration.isCoexistence,
    };

    next();
  } catch (error) {
    next(error);
  }
}
