import crypto from 'node:crypto';
import config from '../config/env.js';

/**
 * Cada POST de webhook de Meta incluye el header X-Hub-Signature-256, un HMAC-SHA256
 * del body crudo usando tu App Secret. Verificarlo evita que alguien te mande
 * payloads falsos haciéndose pasar por Meta. Requiere que el body llegue "raw"
 * (sin parsear) — por eso en server.js usamos express.raw() en esta ruta.
 */
export function verifyMetaSignature(req, res, next) {
  const signatureHeader = req.get('X-Hub-Signature-256');

  if (!signatureHeader) {
    return res.sendStatus(401);
  }

  const expectedHash = crypto
    .createHmac('sha256', config.META_APP_SECRET)
    .update(req.body) // req.body es un Buffer crudo en esta ruta
    .digest('hex');

  const expectedSignature = `sha256=${expectedHash}`;

  const isValid = crypto.timingSafeEqual(
    Buffer.from(signatureHeader),
    Buffer.from(expectedSignature)
  );

  if (!isValid) {
    return res.sendStatus(401);
  }

  // Ya verificado: parseamos el JSON manualmente y lo dejamos disponible.
  req.metaBody = JSON.parse(req.body.toString('utf8'));
  next();
}
