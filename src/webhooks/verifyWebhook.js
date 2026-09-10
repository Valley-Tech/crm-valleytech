import config from '../config/env.js';

/**
 * Meta llama a este endpoint con GET una sola vez, cuando configuras la URL del
 * webhook en App Dashboard > WhatsApp > Configuración. Debes responder con el
 * valor de "hub.challenge" tal cual, solo si "hub.verify_token" coincide con el
 * tuyo. Si esto falla, Meta no dejará guardar la URL del webhook.
 */
export function verifyWebhookHandshake(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
}
