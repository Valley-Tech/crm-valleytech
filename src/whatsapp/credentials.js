import env from '../config/env.js';
import { decryptSecret } from '../lib/crypto.js';

/**
 * Credenciales con las que el CRM habla con Meta en nombre de un número.
 *
 * Cada número puede vivir en una app de Meta distinta (el bot de Samuelito
 * tiene su app, el de MerkaCentro la suya…). El appsecret_proof que exige
 * la Graph API se calcula con el App Secret de la app dueña del token, así
 * que si se usa el secreto del CRM con un token de otra app Meta responde
 * "Invalid appsecret_proof". Por eso cada integración puede guardar el
 * App ID y el App Secret de su propia app; si no los tiene, se asume que el
 * token se generó para la app del CRM (META_APP_ID / META_APP_SECRET).
 */
export function metaCredentials(integration) {
  return {
    accessToken: decryptSecret(integration.accessTokenEnc),
    appId: integration.metaAppId ?? env.META_APP_ID,
    appSecret: integration.metaAppSecretEnc ? decryptSecret(integration.metaAppSecretEnc) : env.META_APP_SECRET,
    isOwnApp: !integration.metaAppSecretEnc,
  };
}

/** Normaliza lo que reciben las funciones de whatsapp/*: string (token) u objeto de credenciales. */
export function resolveCredentials(auth) {
  if (typeof auth === 'string') return { accessToken: auth, appSecret: env.META_APP_SECRET };
  if (auth && typeof auth === 'object' && auth.accessToken) return auth;
  throw new Error('Faltan credenciales de Meta (accessToken)');
}
