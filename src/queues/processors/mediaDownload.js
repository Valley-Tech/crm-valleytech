import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { fetchAndStoreMedia } from '../../services/media.js';

/**
 * Las URLs de multimedia de Meta caducan en minutos. Si no se descarga el
 * archivo al recibir el webhook, se pierde: por eso esto es un trabajo de cola
 * con reintentos y no una descarga perezosa al abrir el chat.
 *
 * Ojo: en Railway el worker y el web son contenedores distintos con discos
 * distintos, y el disco se borra en cada despliegue. Por eso el servidor web,
 * si no encuentra el archivo, lo vuelve a pedir a Meta (services/media.js).
 * Para un almacenamiento de verdad usa STORAGE_DRIVER=s3 (R2, S3, B2…).
 */
export default async function processMediaDownload(job) {
  const { messageId } = job.data;

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: true },
  });

  if (!message?.mediaId) return { skipped: 'no_media' };
  if (message.mediaStorageKey) return { skipped: 'already_downloaded' };

  try {
    const { key } = await fetchAndStoreMedia(message, message.conversation);
    logger.debug({ messageId, key }, 'Multimedia guardada');
    return { key };
  } catch (err) {
    if (err.code === 'no_integration') return { skipped: 'no_integration' };
    throw err;
  }
}
