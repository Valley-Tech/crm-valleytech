/**
 * Puente Mishabella ↔ CRM ValleyTech.
 *
 * Dos modos, elegidos con la variable CRM_MODE:
 *
 *  · mirror  (por defecto) — "espejo". No cambia nada en Meta. El bot sigue
 *    recibiendo el webhook y enviando con su propio token, pero:
 *      - reenvía al CRM cada webhook que recibe  → contactos, chats, estados
 *      - registra en el CRM cada mensaje que envía → las respuestas de Gemini
 *        aparecen en la bandeja como "bot"
 *      - antes de responder pregunta al CRM si el bot sigue activo en ese chat
 *        → el botón "Pausar bot" del CRM funciona
 *
 *  · gateway — el CRM es el único webhook de Meta. El bot recibe los eventos
 *    del CRM en /crm/events y envía SIEMPRE a través del CRM. El bot deja de
 *    necesitar API_TOKEN, BUSINESS_PHONE y APP_SECRET de Meta.
 *
 * Variables de entorno:
 *   CRM_BASE_URL        https://tu-crm.up.railway.app
 *   CRM_API_KEY         apiKey que devolvió el CRM al crear el chatbot (X-Bot-Key)
 *   CRM_SIGNING_SECRET  signingSecret del chatbot (solo modo gateway)
 *   CRM_MODE            mirror | gateway   (por defecto mirror)
 */

import crypto from 'node:crypto';
import express from 'express';
import axios from 'axios';

export const CRM_MODE = (process.env.CRM_MODE || 'mirror').toLowerCase();
const CRM_BASE_URL = (process.env.CRM_BASE_URL || '').replace(/\/$/, '');
const CRM_API_KEY = process.env.CRM_API_KEY;
const CRM_SIGNING_SECRET = process.env.CRM_SIGNING_SECRET;
// phone_number_id del número por el que envía este bot. Así el CRM sabe a qué
// número (y a qué chatbot) pertenece cada chat aunque lo haya abierto el bot.
const CRM_PHONE_NUMBER_ID = process.env.CRM_PHONE_NUMBER_ID || process.env.BUSINESS_PHONE || undefined;

export const crmEnabled = Boolean(CRM_BASE_URL && CRM_API_KEY);
if (!crmEnabled) console.warn('[crm] CRM_BASE_URL o CRM_API_KEY vacíos: el bot funciona sin CRM');

const crm = axios.create({
  baseURL: `${CRM_BASE_URL}/api/v1/bot`,
  timeout: 15000,
  headers: { 'X-Bot-Key': CRM_API_KEY, 'Content-Type': 'application/json' },
});

const describe = (error) =>
  error.response ? `${error.response.status} ${JSON.stringify(error.response.data)}` : error.message;

// ---------------------------------------------------------------------------
//  Conversión del payload de la Cloud API al formato interno del CRM
// ---------------------------------------------------------------------------

/** Convierte lo que hoy se manda a /{phone}/messages en lo que entiende el CRM. */
export function toCrmMessage(data) {
  if (data.status === 'read') return null; // marcar como leído: no es un mensaje

  if (data.text) return { type: 'text', text: data.text.body, previewUrl: Boolean(data.text.preview_url) };
  const type = data.type;
  if (type === 'interactive') return { type, interactive: data.interactive };
  if (type === 'template') {
    return {
      type,
      template: {
        name: data.template.name,
        language: data.template.language?.code ?? 'es',
        components: data.template.components ?? [],
      },
    };
  }
  if (['image', 'audio', 'video', 'document', 'sticker'].includes(type)) return { type, media: data[type] };
  if (type === 'location') return { type, location: data.location };
  if (type === 'contacts') return { type, contacts: data.contacts };
  if (type === 'reaction') return { type, reaction: data.reaction };
  throw new Error(`[crm] tipo de mensaje no soportado: ${type ?? JSON.stringify(data).slice(0, 80)}`);
}

// ---------------------------------------------------------------------------
//  MODO ESPEJO
// ---------------------------------------------------------------------------

/** Reenvía el webhook de Meta tal cual. Nunca lanza: si el CRM está caído, el bot sigue. */
export async function forwardWebhook(body) {
  if (!crmEnabled) return;
  try {
    await crm.post('/webhook', body);
  } catch (error) {
    console.warn('[crm] no se pudo reenviar el webhook:', describe(error));
  }
}

/** Registra un mensaje que el bot YA envió a Meta con su propio token. */
export async function recordSent(to, data, metaResponse) {
  if (!crmEnabled) return;
  const message = toCrmMessage(data);
  if (!message) return;
  try {
    await crm.post('/messages/record', {
      to,
      phoneNumberId: CRM_PHONE_NUMBER_ID,
      ...message,
      waMessageId: metaResponse?.messages?.[0]?.id,
      sentAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('[crm] no se pudo registrar el mensaje enviado:', describe(error));
  }
}

// Caché corta para no preguntar al CRM en cada uno de los 5 mensajes de un menú.
const activeCache = new Map();
/** ¿Sigue activo el bot en la conversación con este número? (true si el CRM no responde). */
export async function canBotReply(to) {
  if (!crmEnabled) return true;
  const cached = activeCache.get(to);
  if (cached && Date.now() - cached.at < 10_000) return cached.active;
  try {
    const { data } = await crm.get('/conversations/lookup', { params: { to } });
    activeCache.set(to, { active: data.botActive !== false, at: Date.now() });
    return data.botActive !== false;
  } catch (error) {
    console.warn('[crm] no se pudo consultar el estado del bot:', describe(error));
    return true;
  }
}

// ---------------------------------------------------------------------------
//  MODO GATEWAY
// ---------------------------------------------------------------------------

/**
 * Envía a través del CRM. Devuelve null (sin lanzar) cuando el CRM decide que
 * el bot no debe hablar: agente al mando (409) o ventana de 24 h cerrada (422).
 */
export async function sendViaCrm(to, data) {
  const message = toCrmMessage(data);
  if (!message) return { ok: true, skipped: 'read' };
  try {
    const { data: created } = await crm.post('/messages', { to, phoneNumberId: CRM_PHONE_NUMBER_ID, ...message });
    return created;
  } catch (error) {
    const code = error.response?.data?.error?.code ?? error.response?.data?.code;
    if (error.response?.status === 409 && code === 'bot_paused') {
      console.log(`[crm] ${to}: un agente tomó la conversación; el bot se calla`);
      return null;
    }
    if (error.response?.status === 422) {
      console.warn(`[crm] ${to}: ventana de 24 h cerrada, solo plantillas`);
      return null;
    }
    console.error('[crm] error enviando por el CRM:', describe(error));
    throw error;
  }
}

/** Reconstruye (message, senderInfo) tal como los recibía handleIncomingMessage desde Meta. */
export function toMetaMessage(event) {
  const raw = event.message?.content ?? {};
  const message = {
    from: raw.from ?? event.contact?.waId,
    id: raw.id ?? event.message?.waMessageId,
    timestamp: raw.timestamp,
    type: raw.type ?? event.message?.type,
    ...raw,
  };
  const senderInfo = { profile: { name: event.contact?.name ?? '' }, wa_id: event.contact?.waId };
  return { message, senderInfo };
}

function isValidSignature(rawBody, timestamp, header) {
  if (!header || !timestamp || !CRM_SIGNING_SECRET) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', CRM_SIGNING_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Router para /crm/events: verifica la firma del CRM, responde 200 enseguida
 * y procesa el evento en segundo plano.
 */
export function createCrmEventsRouter(handleEvent) {
  const router = express.Router();
  router.post('/events', express.raw({ type: 'application/json', limit: '2mb' }), (req, res) => {
    const timestamp = req.get('X-ValleyTech-Timestamp');
    const signature = req.get('X-ValleyTech-Signature');
    // app.js ya parsea JSON y guarda el cuerpo crudo en req.rawBody; la firma se calcula sobre ese texto exacto.
    const rawBody = typeof req.rawBody === 'string' ? req.rawBody
      : Buffer.isBuffer(req.body) ? req.body.toString('utf8')
      : JSON.stringify(req.body ?? {});
    if (!isValidSignature(rawBody, timestamp, signature)) return res.sendStatus(401);
    if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return res.sendStatus(401);

    let event;
    try { event = JSON.parse(rawBody); } catch { return res.sendStatus(400); }
    res.sendStatus(200);
    Promise.resolve(handleEvent(event)).catch((err) => console.error('[crm] error procesando el evento:', err));
  });
  return router;
}
