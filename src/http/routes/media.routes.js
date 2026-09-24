import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { asyncHandler } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { requireAuthAllowQueryToken } from '../middleware/auth.js';
import { loadMedia } from '../../services/media.js';

const router = Router();

/**
 * Sirve el archivo desde el CRM, nunca con la URL temporal de Meta (que caduca).
 *
 * Va en su propio router porque acepta el token por querystring: la bandeja lo
 * usa dentro de <img src> / <audio src>, y esas etiquetas no envían cabeceras.
 *
 * Soporta peticiones por rangos (Range: bytes=…): Safari y iOS las exigen
 * para reproducir audio y video; sin 206 el reproductor se queda en "Error".
 */
router.get(
  '/media/:messageId',
  requireAuthAllowQueryToken,
  asyncHandler(async (req, res) => {
    const message = await prisma.message.findFirst({
      where: { id: req.params.messageId, tenantId: req.auth.tenantId },
      include: { conversation: true },
    });
    if (!message?.mediaStorageKey && !message?.mediaId) throw notFound('Ese mensaje no tiene un archivo guardado');

    let file;
    try {
      file = await loadMedia(message);
    } catch (err) {
      logger.warn({ messageId: message.id, err: err.message }, 'No se pudo obtener el archivo del mensaje');
      throw notFound(
        err.code === 'no_integration'
          ? 'El archivo ya no está en el servidor y la conversación no tiene un número activo para volver a pedirlo a Meta.'
          : 'El archivo ya no está disponible: se perdió del servidor y Meta ya no lo conserva (los guarda unos 30 días). Configura STORAGE_DRIVER=s3 para que no vuelva a pasar.'
      );
    }

    const { buffer, mimeType } = file;
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (message.mediaFilename && !mimeType.startsWith('audio/')) {
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(message.mediaFilename)}"`);
    }

    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && buffer.length > 0) {
      let start = range[1] ? Number(range[1]) : 0;
      let end = range[2] ? Number(range[2]) : buffer.length - 1;
      if (!range[1] && range[2]) { start = Math.max(0, buffer.length - Number(range[2])); end = buffer.length - 1; }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= buffer.length) {
        res.setHeader('Content-Range', `bytes */${buffer.length}`);
        return res.status(416).end();
      }
      end = Math.min(end, buffer.length - 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${buffer.length}`);
      res.setHeader('Content-Length', end - start + 1);
      return res.end(buffer.subarray(start, end + 1));
    }

    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  })
);

export default router;
