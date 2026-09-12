/**
 * Adaptador CRM ↔ chatbot — pégalo en ValleyTechBot, samuelitoRestoBar y BlackStationBot.
 *
 * Sustituye a webhookController + whatsappService + sendToWhatsApp:
 *   · El bot deja de recibir webhooks de Meta (los recibe el CRM).
 *   · El bot deja de conocer el token y el número del cliente.
 *   · El estado conversacional deja de vivir en memoria.
 *
 * Variables de entorno que necesita el bot:
 *   CRM_BASE_URL        https://tu-crm.up.railway.app
 *   CRM_API_KEY         la apiKey que devolvió POST /api/bots
 *   CRM_SIGNING_SECRET  el signingSecret que devolvió POST /api/bots
 */

import crypto from 'node:crypto';
import express from 'express';
import axios from 'axios';

const CRM_BASE_URL = process.env.CRM_BASE_URL;
const CRM_API_KEY = process.env.CRM_API_KEY;
const CRM_SIGNING_SECRET = process.env.CRM_SIGNING_SECRET;

// ---------------------------------------------------------------------------
//  Cliente hacia el CRM
// ---------------------------------------------------------------------------

const crm = axios.create({
  baseURL: `${CRM_BASE_URL}/api/v1/bot`,
  timeout: 15000,
  headers: { 'X-Bot-Key': CRM_API_KEY, 'Content-Type': 'application/json' },
});

/**
 * Envía un mensaje. Devuelve null si un agente tomó la conversación —
 * ese caso NO es un error: es el traspaso a humano funcionando.
 */
async function send(conversationId, message, botState) {
  try {
    const { data } = await crm.post('/messages', { conversationId, ...message, botState });
    return data;
  } catch (error) {
    if (error.response?.status === 409 && error.response.data?.error?.code === 'bot_paused') {
      console.log('[crm] conversación tomada por un agente; el bot se calla');
      return null;
    }
    if (error.response?.status === 422) {
      // service_window_closed: fuera de la ventana de 24 h solo se aceptan plantillas.
      console.warn('[crm] ventana cerrada:', error.response.data?.error?.message);
      return null;
    }
    // A diferencia del sendToWhatsApp original, aquí el error SÍ se propaga.
    throw error;
  }
}

export const crmClient = {
  sendText: (conversationId, text, botState) => send(conversationId, { type: 'text', text }, botState),

  sendButtons: (conversationId, bodyText, buttons, botState) =>
    send(
      conversationId,
      {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
        },
      },
      botState
    ),

  sendTemplate: (conversationId, name, language = 'es', components = []) =>
    send(conversationId, { type: 'template', template: { name, language, components } }),

  handoff: (conversationId, reason) =>
    crm.post(`/conversations/${conversationId}/handoff`, { reason }).then((r) => r.data),

  saveState: (conversationId, botState) =>
    crm.patch(`/conversations/${conversationId}/state`, botState).then((r) => r.data),

  getConversation: (conversationId) => crm.get(`/conversations/${conversationId}`).then((r) => r.data),
};

// ---------------------------------------------------------------------------
//  Receptor de eventos del CRM
// ---------------------------------------------------------------------------

/** Verificación de firma en tiempo constante, tolerante a longitudes distintas. */
function isValidSignature(rawBody, timestamp, header) {
  if (!header || !timestamp) return false;

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', CRM_SIGNING_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');

  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Monta la ruta que recibe los eventos.
 *
 *   const router = createCrmRouter(async (event) => { ... });
 *   app.use('/crm', router);   // endpointUrl = https://tu-bot/crm/events
 *
 * El handler recibe el evento ya verificado. Devuelve 200 rápido: procesa en
 * segundo plano para que el CRM no reintente por tardanza.
 */
export function createCrmRouter(handleEvent) {
  const router = express.Router();

  router.post('/events', express.raw({ type: 'application/json' }), (req, res) => {
    const timestamp = req.get('X-ValleyTech-Timestamp');
    const signature = req.get('X-ValleyTech-Signature');
    const rawBody = req.body.toString('utf8');

    if (!isValidSignature(rawBody, timestamp, signature)) {
      return res.sendStatus(401);
    }

    // Rechaza eventos viejos (protección contra repetición).
    if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) {
      return res.sendStatus(401);
    }

    const event = JSON.parse(rawBody);
    res.sendStatus(200);

    Promise.resolve(handleEvent(event)).catch((err) =>
      console.error('[crm] error procesando el evento:', err)
    );
  });

  return router;
}

// ---------------------------------------------------------------------------
//  Ejemplo de uso
// ---------------------------------------------------------------------------

/*
import { createCrmRouter, crmClient } from './crmAdapter.js';  // este archivo

const app = express();

app.use('/crm', createCrmRouter(async (event) => {
  const { conversation, contact, message } = event;

  // El estado ya no vive en memoria: llega en cada evento y se guarda al responder.
  const state = conversation.botState ?? { paso: 'inicio' };
  const texto = (message.text ?? '').trim().toLowerCase();

  if (state.paso === 'inicio') {
    await crmClient.sendButtons(
      conversation.id,
      `¡Hola ${contact.name ?? ''}! ¿Qué necesitas?`,
      [{ id: 'pedido', title: 'Hacer un pedido' }, { id: 'asesor', title: 'Hablar con alguien' }],
      { paso: 'menu' }
    );
    return;
  }

  if (state.paso === 'menu' && texto.includes('alguien')) {
    await crmClient.sendText(conversation.id, 'Te comunico con un asesor.', { paso: 'humano' });
    await crmClient.handoff(conversation.id, 'el cliente pidió un asesor');
    return;
  }

  await crmClient.sendText(conversation.id, 'No entendí. ¿Puedes repetirlo?', state);
}));

app.listen(process.env.PORT ?? 3001);
*/
