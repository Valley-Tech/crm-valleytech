import express, { Router } from 'express';
import env from '../config/env.js';
import logger from '../lib/logger.js';
import { isValidMetaSignature } from '../lib/signature.js';
import { inboundQueue } from '../queues/index.js';

const router = Router();

/**
 * Handshake de verificación. Meta lo llama una vez al guardar la URL.
 */
router.get('/webhooks/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.META_WEBHOOK_VERIFY_TOKEN) {
    logger.info('Handshake de webhook verificado por Meta');
    return res.status(200).send(challenge);
  }

  logger.warn('Handshake de webhook rechazado: verify_token no coincide');
  return res.sendStatus(403);
});

/**
 * Punto de entrada único de TODOS los clientes.
 *
 * Una app de Meta tiene un solo webhook, así que aquí llegan los eventos de
 * todas las WABA suscritas. El trabajo es: verificar la firma, encolar cada
 * change y devolver 200 cuanto antes. Nada de base de datos en esta ruta.
 */
router.post(
  '/webhooks/meta',
  express.raw({ type: 'application/json', limit: '5mb' }),
  async (req, res) => {
    if (!isValidMetaSignature(req.body, req.get('X-Hub-Signature-256'))) {
      logger.warn({ ip: req.ip }, 'Webhook con firma inválida');
      return res.sendStatus(401);
    }

    let body;
    try {
      body = JSON.parse(req.body.toString('utf8'));
    } catch {
      logger.warn('Webhook con cuerpo JSON ilegible');
      return res.sendStatus(400);
    }

    // Responder primero: Meta reintenta (y duplica) si tardamos.
    res.sendStatus(200);

    try {
      const jobs = [];
      // Meta agrupa varias entry y varios changes en un mismo POST.
      // El código anterior solo leía entry[0].changes[0] y perdía el resto.
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          jobs.push({
            name: change.field ?? 'unknown',
            data: {
              entryId: entry.id,
              field: change.field,
              value: change.value,
              receivedAt: new Date().toISOString(),
            },
          });
        }
      }

      if (jobs.length > 0) await inboundQueue.addBulk(jobs);
      logger.debug({ count: jobs.length }, 'Eventos de Meta encolados');
    } catch (err) {
      logger.error({ err }, 'No se pudieron encolar los eventos de Meta');
    }
  }
);

export default router;
