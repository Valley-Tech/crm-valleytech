import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { requireAuthAllowQueryToken } from '../middleware/auth.js';
import { getObject } from '../../storage/index.js';

const router = Router();

/**
 * Sirve el archivo desde el CRM, nunca con la URL temporal de Meta (que caduca).
 *
 * Va en su propio router porque acepta el token por querystring: la bandeja lo
 * usa dentro de <img src>, y una etiqueta img no puede enviar cabeceras.
 */
router.get(
  '/media/:messageId',
  requireAuthAllowQueryToken,
  asyncHandler(async (req, res) => {
    const message = await prisma.message.findFirst({
      where: { id: req.params.messageId, tenantId: req.auth.tenantId },
    });
    if (!message?.mediaStorageKey) throw notFound('Ese mensaje no tiene un archivo guardado');

    const buffer = await getObject(message.mediaStorageKey);
    res.setHeader('Content-Type', message.mediaMimeType ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (message.mediaFilename) {
      res.setHeader('Content-Disposition', `inline; filename="${message.mediaFilename}"`);
    }
    res.send(buffer);
  })
);

export default router;
