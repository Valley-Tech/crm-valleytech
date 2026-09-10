import axios from 'axios';
import config from '../../config/env.js';

const MAX_RETRIES = 3;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Envía un payload a la API de WhatsApp Cloud para un tenant específico.
 *
 * @param {object} data - Payload del mensaje (messaging_product, to, type, ...)
 * @param {string} phoneNumberId - El Phone Number ID del TENANT que envía (no un valor global)
 * @param {string} accessToken - Token de System User del tenant, ya descifrado
 * @returns {Promise<{ whatsappMessageId: string, raw: object }>}
 */
async function sendToWhatsApp(data, phoneNumberId, accessToken) {
  const url = `${config.BASE_URL}/${config.API_VERSION}/${phoneNumberId}/messages`;
  const headers = { Authorization: `Bearer ${accessToken}` };

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await axios({ method: 'POST', url, headers, data });

      // Bug corregido: era "response.datal" (typo), ahora "response.data".
      // El id del mensaje es indispensable para poder rastrear su estado
      // cuando lleguen los webhooks de status (sent/delivered/read/failed).
      const whatsappMessageId = response.data?.messages?.[0]?.id ?? null;

      return { whatsappMessageId, raw: response.data };
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const isRetryable = RETRYABLE_STATUS_CODES.has(status);

      if (!isRetryable || attempt === MAX_RETRIES) {
        break;
      }

      // Backoff exponencial simple: 1s, 2s, 4s...
      await wait(2 ** (attempt - 1) * 1000);
    }
  }

  // Propagamos el error para que quien llame (el worker de la cola) decida
  // si reintentar vía BullMQ, marcar el mensaje como fallido, etc.
  const metaError = lastError.response?.data?.error;
  const message = metaError?.message || lastError.message;
  const err = new Error(`Error enviando mensaje a WhatsApp: ${message}`);
  err.metaError = metaError;
  err.status = lastError.response?.status;
  throw err;
}

export default sendToWhatsApp;
