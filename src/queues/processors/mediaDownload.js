import path from 'node:path';
import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { downloadMedia } from '../../whatsapp/media.js';
import { resolveIntegration } from '../../services/conversations.js';
import { putObject } from '../../storage/index.js';
import { metaCredentials } from '../../whatsapp/credentials.js';

const EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'video/mp4': '.mp4',
  'application/pdf': '.pdf',
};

/**
 * Las URLs de multimedia de Meta caducan en minutos. Si no se descarga el
 * archivo al recibir el webhook, se pierde: por eso esto es un trabajo de cola
 * con reintentos y no una descarga perezosa al abrir el chat.
 */
export default async function processMediaDownload(job) {
  const { messageId } = job.data;

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: true },
  });

  if (!message?.mediaId) return { skipped: 'no_media' };
  if (message.mediaStorageKey) return { skipped: 'already_downloaded' };

  const integration = await resolveIntegration(message.conversation);
  if (!integration) return { skipped: 'no_integration' };

  const accessToken = metaCredentials(integration);
  const file = await downloadMedia(message.mediaId, accessToken);

  const extension =
    (message.mediaFilename ? path.extname(message.mediaFilename) : '') ||
    EXTENSIONS[file.mimeType] ||
    '';
  const key = `${message.tenantId}/${message.id}${extension}`;

  await putObject(key, file.buffer, file.mimeType);

  await prisma.message.update({
    where: { id: message.id },
    data: {
      mediaStorageKey: key,
      mediaMimeType: file.mimeType ?? message.mediaMimeType,
      mediaSizeBytes: file.sizeBytes ?? null,
    },
  });

  logger.debug({ messageId, key }, 'Multimedia guardada');
  return { key };
}
