import env from '../config/env.js';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { decryptSecret } from '../lib/crypto.js';

/**
 * Secretos con los que puede venir firmado un webhook.
 *
 * Meta firma cada POST con el App Secret de la app que lo envía. Como el CRM
 * acepta números conectados desde otras apps de Meta (cada una con su propio
 * secreto), la firma se verifica contra el secreto del CRM y contra los de
 * todas las integraciones que declararon su propia app. Se cachean un minuto
 * para no tocar la base de datos en cada webhook.
 */
const TTL_MS = 60_000;
let cache = { secrets: [env.META_APP_SECRET], loadedAt: 0 };

export async function webhookSecrets({ force = false } = {}) {
  if (!force && Date.now() - cache.loadedAt < TTL_MS) return cache.secrets;
  try {
    const rows = await prisma.metaIntegration.findMany({
      where: { metaAppSecretEnc: { not: null } },
      select: { metaAppSecretEnc: true },
      distinct: ['metaAppSecretEnc'],
    });
    const extra = rows.map((r) => {
      try { return decryptSecret(r.metaAppSecretEnc); } catch { return null; }
    });
    cache = { secrets: [env.META_APP_SECRET, ...extra.filter(Boolean)], loadedAt: Date.now() };
  } catch (err) {
    logger.error({ err }, 'No se pudieron cargar los secretos de webhook; se usa solo el del CRM');
    cache.loadedAt = Date.now();
  }
  return cache.secrets;
}

export function invalidateWebhookSecrets() {
  cache.loadedAt = 0;
}
