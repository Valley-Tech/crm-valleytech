import { messageQueue } from '../queue/messageQueue.js';

/**
 * Meta espera un 200 en menos de ~10 segundos o reintenta el webhook (y puede
 * duplicarlo). Por eso aquí NO procesamos nada pesado: solo encolamos el
 * evento crudo en BullMQ y respondemos de inmediato. El worker (queue/worker.js)
 * es quien realmente actualiza la base de datos, corre el bot, etc.
 */
export async function handleIncomingWebhook(req, res) {
  const body = req.metaBody;
  const { tenantId, phoneNumberId } = req.tenantContext ?? {};

  if (!tenantId) {
    // Ya se resolvió que no pertenece a ningún tenant conocido en el middleware anterior.
    return res.sendStatus(200);
  }

  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const field = change?.field; // "messages" | "account_update" | "history" | "smb_app_state_sync" | "smb_message_echoes"

  await messageQueue.add(
    'process-webhook-event',
    {
      tenantId,
      phoneNumberId,
      field,
      value: change?.value,
    },
    {
      // Rate limit por número (coexistencia limita a 20 msg/s por línea);
      // agrupamos el job bajo un id que incluye el phoneNumberId para que
      // BullMQ pueda aplicar limiters por grupo si se configuran a futuro.
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    }
  );

  return res.sendStatus(200);
}
