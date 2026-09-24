import path from 'node:path';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { downloadMedia } from '../whatsapp/media.js';
import { metaCredentials } from '../whatsapp/credentials.js';
import { resolveIntegration } from './conversations.js';
import { putObject, getObject } from '../storage/index.js';
import { transcodeAudio } from '../lib/audio.js';

export const EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/amr': '.amr',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'application/pdf': '.pdf',
};

/** "audio/ogg; codecs=opus" → "audio/ogg" (para buscar la extensión y servir bien el tipo). */
export function baseMime(mimeType = '') {
  return String(mimeType ?? '').split(';')[0].trim().toLowerCase();
}

/** ¿El error dice que el archivo no existe? (disco local o S3). */
export function isMissingFile(err) {
  return err?.code === 'ENOENT' || err?.name === 'NoSuchKey' || err?.Code === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;
}

/**
 * Descarga el medio desde Meta con el token del número y lo guarda en el
 * almacenamiento. Devuelve { buffer, mimeType, key }. La usa el worker al
 * recibir el webhook y el servidor web cuando el archivo ya no está.
 */
export async function fetchAndStoreMedia(message, conversation) {
  if (!message.mediaId) throw Object.assign(new Error('El mensaje no tiene id de medio en Meta'), { code: 'no_media_id' });

  const integration = await resolveIntegration(conversation ?? message.conversation);
  if (!integration) throw Object.assign(new Error('La conversación no tiene un número de WhatsApp activo para descargar el archivo'), { code: 'no_integration' });

  const file = await downloadMedia(message.mediaId, metaCredentials(integration));
  let buffer = file.buffer;
  let mimeType = baseMime(file.mimeType) || baseMime(message.mediaMimeType) || 'application/octet-stream';

  // Las notas de voz llegan como audio/ogg (opus). Si hay ffmpeg, se pasan a
  // mp3 para que suenen en cualquier navegador (iPhone < iOS 18.4 no lee ogg).
  if (mimeType.startsWith('audio/')) {
    const converted = await transcodeAudio(buffer, mimeType);
    if (converted) { buffer = converted.buffer; mimeType = converted.mimeType; }
  }

  const extension =
    (message.mediaFilename ? path.extname(message.mediaFilename) : '') ||
    EXTENSIONS[mimeType] ||
    '';
  const key = `${message.tenantId}/${message.id}${extension}`;

  await putObject(key, buffer, mimeType);
  await prisma.message.update({
    where: { id: message.id },
    data: { mediaStorageKey: key, mediaMimeType: mimeType, mediaSizeBytes: buffer.length },
  });

  return { buffer, mimeType, key };
}

/**
 * Devuelve el archivo de un mensaje. Si el almacenamiento local ya no lo
 * tiene (Railway borra el disco en cada despliegue, y el worker y el web son
 * contenedores distintos con discos distintos), lo vuelve a pedir a Meta y lo
 * guarda otra vez. Meta conserva los medios recibidos unos 30 días.
 */
export async function loadMedia(message) {
  if (message.mediaStorageKey) {
    try {
      const buffer = await getObject(message.mediaStorageKey);
      return { buffer, mimeType: baseMime(message.mediaMimeType) || 'application/octet-stream', recovered: false };
    } catch (err) {
      if (!isMissingFile(err)) throw err;
      logger.warn({ messageId: message.id, key: message.mediaStorageKey }, 'Archivo ausente en el almacenamiento: se vuelve a descargar de Meta');
    }
  }

  const conversation = message.conversation ?? (await prisma.conversation.findUnique({ where: { id: message.conversationId } }));
  const stored = await fetchAndStoreMedia(message, conversation);
  return { ...stored, recovered: true };
}
