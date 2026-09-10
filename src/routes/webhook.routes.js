import { Router } from 'express';
import express from 'express';
import { verifyWebhookHandshake } from '../webhooks/verifyWebhook.js';
import { verifyMetaSignature } from '../webhooks/verifySignature.js';
import { resolveTenantFromWebhook } from '../middleware/tenantResolver.js';
import { handleIncomingWebhook } from '../webhooks/webhookController.js';

const router = Router();

// Handshake de verificación (una sola vez, al configurar la URL en Meta)
router.get('/webhook', verifyWebhookHandshake);

// Eventos reales: se usa express.raw() SOLO aquí porque verifyMetaSignature
// necesita el body sin parsear para calcular el HMAC correctamente.
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  verifyMetaSignature,
  resolveTenantFromWebhook,
  handleIncomingWebhook
);

export default router;
