import { redis } from '../lib/redis.js';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

/**
 * Rastro mínimo de lo que llega al webhook, para poder responder a
 * "¿por qué no me llegan mensajes?" sin abrir los logs de Railway.
 *
 *  - crm:webhook:last            → último POST aceptado (fecha, campos, ids)
 *  - crm:webhook:last_rejected   → último POST rechazado por firma
 *  - crm:webhook:unknown         → hash phone_number_id → fecha, para números
 *                                  que Meta sí envía pero no están conectados
 *  - meta_integrations.last_webhook_at / last_inbound_at → por número
 */
const KEY_LAST = 'crm:webhook:last';
const KEY_REJECTED = 'crm:webhook:last_rejected';
const KEY_UNKNOWN = 'crm:webhook:unknown';
const TTL = 60 * 60 * 24 * 14; // dos semanas

export async function noteWebhookReceived({ body, jobs = 0, rejected = null }) {
  const at = new Date().toISOString();
  if (rejected) {
    await redis.set(KEY_REJECTED, JSON.stringify({ at, reason: rejected }), 'EX', TTL);
    return;
  }
  const fields = [];
  const phoneNumberIds = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      fields.push(change.field);
      const id = change.value?.metadata?.phone_number_id;
      if (id) phoneNumberIds.push(id);
    }
  }
  await redis.set(
    KEY_LAST,
    JSON.stringify({ at, jobs, fields: [...new Set(fields)], phoneNumberIds: [...new Set(phoneNumberIds)] }),
    'EX',
    TTL
  );
}

export async function noteUnknownPhoneNumber(phoneNumberId, entryId) {
  if (!phoneNumberId && !entryId) return;
  await redis.hset(KEY_UNKNOWN, phoneNumberId ?? `waba:${entryId}`, new Date().toISOString());
  await redis.expire(KEY_UNKNOWN, TTL);
}

// Se escribe como mucho una vez cada 20 s por número para no castigar la base
// de datos con un UPDATE por cada estado de entrega.
const lastWrite = new Map();
export async function touchIntegrationActivity(integrationId, { inbound = false } = {}) {
  const now = Date.now();
  const key = `${integrationId}:${inbound ? 'in' : 'any'}`;
  if (now - (lastWrite.get(key) ?? 0) < 20_000) return;
  lastWrite.set(key, now);
  const at = new Date(now);
  try {
    await prisma.metaIntegration.update({
      where: { id: integrationId },
      data: inbound ? { lastWebhookAt: at, lastInboundAt: at } : { lastWebhookAt: at },
    });
  } catch (err) {
    logger.debug({ err: err.message }, 'No se pudo anotar la actividad de la integración');
  }
}

export async function webhookDiagnostics() {
  const [last, rejected, unknown] = await Promise.all([
    redis.get(KEY_LAST),
    redis.get(KEY_REJECTED),
    redis.hgetall(KEY_UNKNOWN),
  ]);
  return {
    lastAccepted: last ? JSON.parse(last) : null,
    lastRejected: rejected ? JSON.parse(rejected) : null,
    unknownPhoneNumbers: Object.entries(unknown ?? {}).map(([phoneNumberId, at]) => ({ phoneNumberId, at })),
  };
}
