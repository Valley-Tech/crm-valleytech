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
// Negocios que completaron el registro insertado ALOJADO por Meta (o el
// registro desde otra web) y aún no están conectados en ningún cliente.
const KEY_PARTNERS = 'crm:webhook:partner_added';
const TTL = 60 * 60 * 24 * 14; // dos semanas
const TTL_PARTNERS = 60 * 60 * 24 * 30;

/**
 * account_update PARTNER_ADDED: un negocio compartió su WABA con ValleyTech
 * (registro alojado por Meta, o registro insertado hecho fuera del CRM). Se
 * guarda para que un administrador lo conecte desde Números de WhatsApp.
 */
export async function notePartnerAdded({ wabaId, businessId = null, event = 'PARTNER_ADDED' }) {
  if (!wabaId) return;
  await redis.hset(KEY_PARTNERS, wabaId, JSON.stringify({ wabaId, businessId, event, at: new Date().toISOString() }));
  await redis.expire(KEY_PARTNERS, TTL_PARTNERS);
}

export async function listPartnersAdded() {
  const raw = await redis.hgetall(KEY_PARTNERS);
  return Object.values(raw ?? {})
    .map((v) => { try { return JSON.parse(v); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

export async function clearPartnerAdded(wabaId) {
  await redis.hdel(KEY_PARTNERS, wabaId);
}

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
