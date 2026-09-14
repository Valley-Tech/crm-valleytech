import crypto from 'node:crypto';
import env from '../config/env.js';
import { safeEqual } from './crypto.js';

/**
 * Verifica la cabecera X-Hub-Signature-256 de Meta sobre el cuerpo crudo.
 *
 * Nota: crypto.timingSafeEqual lanza RangeError si los búferes tienen
 * longitudes distintas, así que la comparación pasa por safeEqual, que
 * compara longitud primero y devuelve false en vez de reventar.
 */
export function isValidMetaSignature(rawBody, signatureHeader, secrets = [env.META_APP_SECRET]) {
  if (!signatureHeader || !Buffer.isBuffer(rawBody)) return false;

  // Cada app de Meta firma con su propio App Secret. El CRM puede recibir
  // webhooks de varias apps (una por cliente), así que se prueba con todos.
  for (const secret of new Set(secrets.filter(Boolean))) {
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (safeEqual(signatureHeader, expected)) return true;
  }
  return false;
}

/** ¿Con cuál de los secretos se firmó el cuerpo? (para saber de qué app viene). */
export function matchMetaSignature(rawBody, signatureHeader, secrets) {
  if (!signatureHeader || !Buffer.isBuffer(rawBody)) return null;
  for (const secret of new Set(secrets.filter(Boolean))) {
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (safeEqual(signatureHeader, expected)) return secret;
  }
  return null;
}

/** Firma el cuerpo que el CRM envía a un chatbot externo. */
export function signBotPayload(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * appsecret_proof: Meta lo exige (o lo recomienda) para llamadas server-to-server.
 * Es el HMAC-SHA256 del access token usando el app secret.
 */
export function appSecretProof(accessToken, appSecret = env.META_APP_SECRET) {
  return crypto.createHmac('sha256', appSecret).update(accessToken).digest('hex');
}
