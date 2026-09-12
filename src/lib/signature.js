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
export function isValidMetaSignature(rawBody, signatureHeader) {
  if (!signatureHeader || !Buffer.isBuffer(rawBody)) return false;

  const expected =
    'sha256=' + crypto.createHmac('sha256', env.META_APP_SECRET).update(rawBody).digest('hex');

  return safeEqual(signatureHeader, expected);
}

/** Firma el cuerpo que el CRM envía a un chatbot externo. */
export function signBotPayload(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * appsecret_proof: Meta lo exige (o lo recomienda) para llamadas server-to-server.
 * Es el HMAC-SHA256 del access token usando el app secret.
 */
export function appSecretProof(accessToken) {
  return crypto.createHmac('sha256', env.META_APP_SECRET).update(accessToken).digest('hex');
}
