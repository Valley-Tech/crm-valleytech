import env from '../config/env.js';
import { metaCredentials } from '../whatsapp/credentials.js';
import {
  getPhoneNumberDetails,
  listSubscribedApps,
  getAppWebhookSubscriptions,
  debugTokenWith,
} from '../whatsapp/embeddedSignup.js';
import { webhookDiagnostics } from './webhookDiagnostics.js';

/**
 * Responde a la pregunta "¿por qué este número no recibe mensajes?" con una
 * lista de comprobaciones concretas, cada una con qué hacer si falla.
 *
 * Para que un mensaje llegue a la bandeja hacen falta, en orden:
 *   1. El token sirve (Meta responde con los datos del número).
 *   2. La app dueña del token está suscrita a la WABA (subscribed_apps).
 *   3. Esa app tiene como URL de webhook la del CRM y el campo "messages".
 *   4. El webhook llega firmado con un App Secret que el CRM conoce.
 *   5. El phone_number_id del evento coincide con el de la integración.
 *   6. El worker procesa la cola.
 */
export async function diagnoseIntegration(integration) {
  const credentials = metaCredentials(integration);
  const expectedWebhookUrl = `${env.PUBLIC_URL.replace(/\/$/, '')}/webhooks/meta`;
  const checks = [];
  const add = (id, ok, title, detail, fix = null, level = ok ? 'ok' : 'error') =>
    checks.push({ id, ok, level, title, detail, fix });

  // 1. Token y número --------------------------------------------------------
  let phone = null;
  try {
    phone = await getPhoneNumberDetails(integration.phoneNumberId, credentials);
    add('token', true, 'Token válido', `Meta reconoce el número ${phone.display_phone_number ?? ''} (${phone.verified_name ?? 'sin nombre'}).`);
  } catch (err) {
    add('token', false, 'Meta rechaza el token', err.message, 'Reconecta el número con un token nuevo de usuario del sistema generado para la app del CRM.');
  }

  if (phone) {
    const connected = phone.status === 'CONNECTED';
    add(
      'phone_status',
      connected || !phone.status,
      connected ? 'Número conectado a la Cloud API' : `Estado del número: ${phone.status ?? 'desconocido'}`,
      `Verificación: ${phone.code_verification_status ?? '—'} · Plataforma: ${phone.platform_type ?? '—'} · Nombre: ${phone.name_status ?? '—'}`,
      connected ? null : 'En Meta for Developers → WhatsApp → Configuración de la API, verifica el número y regístralo (PIN de 6 dígitos).',
      connected || !phone.status ? 'ok' : 'warn'
    );
  }

  // 2. ¿Con qué app se generó el token? ---------------------------------------
  let tokenAppId = null;
  try {
    const info = await debugTokenWith(credentials.accessToken, credentials.appId, credentials.appSecret);
    tokenAppId = info?.app_id ?? null;
    const sameApp = tokenAppId === credentials.appId;
    const expires = info?.expires_at ? new Date(info.expires_at * 1000) : null;
    add(
      'token_app',
      sameApp,
      sameApp ? `Token generado por la app ${tokenAppId}` : `El token es de la app ${tokenAppId}, no de la ${credentials.appId}`,
      `Tipo: ${info?.type ?? '—'} · Caduca: ${expires ? expires.toISOString() : 'nunca'} · Permisos: ${(info?.scopes ?? []).join(', ') || '—'}`,
      sameApp ? null : 'Genera el token desde la app del CRM, o guarda en esta integración el App ID y App Secret de la app dueña del token.',
      sameApp ? 'ok' : 'warn'
    );
  } catch (err) {
    add('token_app', true, 'No se pudo inspeccionar el token', err.message, null, 'warn');
  }

  // 3. Suscripción de la app a la WABA ----------------------------------------
  let subscribed = null;
  try {
    const result = await listSubscribedApps(integration.wabaId, credentials);
    const apps = result?.data ?? [];
    const appIds = apps.map((a) => a.whatsapp_business_api_data?.id ?? a.id).filter(Boolean);
    subscribed = appIds.includes(credentials.appId);
    add(
      'subscribed',
      subscribed,
      subscribed ? `La app ${credentials.appId} está suscrita a la WABA` : `La app ${credentials.appId} NO está suscrita a la WABA`,
      apps.length
        ? `Apps suscritas: ${apps.map((a) => `${a.whatsapp_business_api_data?.name ?? a.name ?? '?'} (${a.whatsapp_business_api_data?.id ?? a.id})`).join(', ')}`
        : 'Ninguna app está suscrita a esta WABA: Meta no envía webhooks a nadie.',
      subscribed ? null : 'Pulsa "Suscribir webhooks" aquí mismo, o en Meta for Developers → WhatsApp → Configuración → suscríbete a la WABA.'
    );
  } catch (err) {
    add('subscribed', false, 'No se pudo consultar subscribed_apps', err.message, 'El token necesita el permiso whatsapp_business_management sobre esta WABA.');
  }

  // 4. Webhook de la app -------------------------------------------------------
  try {
    const subs = await getAppWebhookSubscriptions(credentials.appId, credentials.appSecret);
    const wa = subs.find((s) => s.object === 'whatsapp_business_account');
    const url = wa?.callback_url ?? null;
    const fields = (wa?.fields ?? []).map((f) => (typeof f === 'string' ? f : f.name));
    const urlOk = url === expectedWebhookUrl;
    const hasMessages = fields.includes('messages');
    add(
      'webhook_url',
      Boolean(wa) && urlOk && wa.active !== false,
      !wa ? 'La app no tiene webhook de WhatsApp configurado' : urlOk ? 'El webhook de la app apunta al CRM' : 'El webhook de la app apunta a OTRA URL',
      wa ? `URL: ${url} · Activo: ${wa.active !== false}` : `Debe ser ${expectedWebhookUrl}`,
      wa && urlOk ? null : `En Meta for Developers → WhatsApp → Configuración → Webhook, pon la URL ${expectedWebhookUrl} y el token de verificación del CRM. Si esa URL la usa hoy tu chatbot, conéctalo por el Bot Gateway.`
    );
    add(
      'webhook_fields',
      hasMessages,
      hasMessages ? 'Campo "messages" suscrito' : 'Falta suscribir el campo "messages"',
      `Campos: ${fields.join(', ') || 'ninguno'}`,
      hasMessages ? null : 'En la configuración del webhook, pulsa "Suscribirse" en messages (y en message_template_status_update, smb_message_echoes, history, smb_app_state_sync).'
    );
  } catch (err) {
    add('webhook_url', true, 'No se pudo leer el webhook de la app', err.message, 'Solo se puede consultar para apps cuyo App Secret conoce el CRM.', 'warn');
  }

  // 5. Actividad real vista por el CRM ----------------------------------------
  const global = await webhookDiagnostics();
  const unknown = global.unknownPhoneNumbers.find((u) => u.phoneNumberId === integration.phoneNumberId);
  add(
    'activity',
    Boolean(integration.lastWebhookAt),
    integration.lastWebhookAt ? `Último webhook de este número: ${integration.lastWebhookAt.toISOString()}` : 'El CRM nunca ha recibido un webhook de este número',
    integration.lastInboundAt ? `Último mensaje entrante: ${integration.lastInboundAt.toISOString()}` : 'Sin mensajes entrantes registrados.',
    integration.lastWebhookAt ? null : 'Si las comprobaciones anteriores están en verde, escribe al número desde un celular y vuelve a diagnosticar. Si la app de Meta está en modo Desarrollo, Meta solo entrega eventos de números con rol en la app: pásala a modo Activo.',
    integration.lastWebhookAt ? 'ok' : 'warn'
  );
  if (unknown) {
    add('unknown', false, 'Llegaron webhooks de este número cuando aún no estaba conectado', `Último: ${unknown.at}`, 'Ya está conectado; los próximos eventos se procesarán. Escribe de nuevo al número.', 'warn');
  }
  if (global.lastRejected) {
    add('signature', false, 'El CRM rechazó webhooks por firma inválida', `Último rechazo: ${global.lastRejected.at}`, 'Esos webhooks vienen de una app cuyo App Secret el CRM no conoce. Guarda el App ID/App Secret de esa app en la integración correspondiente.', 'warn');
  }

  return {
    integrationId: integration.id,
    phoneNumberId: integration.phoneNumberId,
    wabaId: integration.wabaId,
    appId: credentials.appId,
    ownApp: credentials.isOwnApp,
    expectedWebhookUrl,
    phone,
    global,
    checks,
    healthy: checks.every((c) => c.level !== 'error'),
  };
}
