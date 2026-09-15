import env from '../config/env.js';
import { graphRequest } from './graph.js';
import axios from 'axios';

/**
 * Registro insertado (Embedded Signup) — alta automática de clientes.
 *
 * Requiere que Meta apruebe la revisión de la app con los permisos
 * whatsapp_business_management, whatsapp_business_messaging y business_management.
 * Mientras tanto se usa el alta manual de /api/integrations/meta.
 */

/** Cambia el código que devuelve el diálogo del SDK por un access token. */
export async function exchangeCodeForToken(code) {
  const response = await axios({
    method: 'GET',
    url: `${env.META_GRAPH_URL}/${env.META_API_VERSION}/oauth/access_token`,
    params: {
      client_id: env.META_APP_ID,
      client_secret: env.META_APP_SECRET,
      code,
    },
    timeout: 20000,
  });
  return response.data; // { access_token, token_type, expires_in? }
}

/** Lee qué WABA y qué permisos ampara el token recién obtenido. */
export async function debugToken(accessToken) {
  const response = await axios({
    method: 'GET',
    url: `${env.META_GRAPH_URL}/${env.META_API_VERSION}/debug_token`,
    params: {
      input_token: accessToken,
      access_token: `${env.META_APP_ID}|${env.META_APP_SECRET}`,
    },
    timeout: 20000,
  });
  return response.data?.data;
}

/** Suscribe tu app a los webhooks de esa WABA. Sin esto no llega nada. */
export async function subscribeAppToWaba(wabaId, accessToken) {
  return graphRequest({ method: 'POST', path: `${wabaId}/subscribed_apps`, accessToken });
}

/** Registra el número en la Cloud API con su PIN de verificación en dos pasos. */
export async function registerPhoneNumber(phoneNumberId, accessToken, pin) {
  return graphRequest({
    method: 'POST',
    path: `${phoneNumberId}/register`,
    accessToken,
    data: { messaging_product: 'whatsapp', pin },
  });
}

/** Datos del número: nombre verificado, calidad y límite de mensajería. */
export async function getPhoneNumber(phoneNumberId, accessToken) {
  return graphRequest({
    path: phoneNumberId,
    accessToken,
    params: { fields: 'display_phone_number,verified_name,quality_rating,messaging_limit_tier' },
  });
}

/** Números asociados a una WABA. */
export async function listWabaPhoneNumbers(wabaId, accessToken) {
  return graphRequest({
    path: `${wabaId}/phone_numbers`,
    accessToken,
    params: { fields: 'id,display_phone_number,verified_name,quality_rating' },
  });
}

/** Apps suscritas a los webhooks de la WABA. Si la app del CRM no está aquí, no llega nada. */
export async function listSubscribedApps(wabaId, accessToken) {
  return graphRequest({ path: `${wabaId}/subscribed_apps`, accessToken });
}

/** Datos ampliados del número para diagnóstico (estado, verificación, plataforma). */
export async function getPhoneNumberDetails(phoneNumberId, accessToken) {
  return graphRequest({
    path: phoneNumberId,
    accessToken,
    params: {
      fields:
        'display_phone_number,verified_name,quality_rating,messaging_limit_tier,status,name_status,code_verification_status,platform_type,is_official_business_account',
    },
  });
}

/**
 * Webhook configurado en una app de Meta (URL de callback y campos).
 * Usa el token de app (id|secret): solo sirve para apps cuyo secreto conoce el CRM.
 */
export async function getAppWebhookSubscriptions(appId, appSecret) {
  const response = await axios({
    method: 'GET',
    url: `${env.META_GRAPH_URL}/${env.META_API_VERSION}/${appId}/subscriptions`,
    params: { access_token: `${appId}|${appSecret}` },
    timeout: 20000,
  });
  return response.data?.data ?? [];
}

/** Con qué app se generó un token (app_id, tipo, caducidad, scopes). */
export async function debugTokenWith(accessToken, appId, appSecret) {
  const response = await axios({
    method: 'GET',
    url: `${env.META_GRAPH_URL}/${env.META_API_VERSION}/debug_token`,
    params: { input_token: accessToken, access_token: `${appId}|${appSecret}` },
    timeout: 20000,
  });
  return response.data?.data;
}

/** Quita la suscripción de la app a los webhooks de esa WABA (al eliminar el último número de la WABA). */
export async function unsubscribeAppFromWaba(wabaId, accessToken) {
  return graphRequest({ method: 'DELETE', path: `${wabaId}/subscribed_apps`, accessToken });
}
