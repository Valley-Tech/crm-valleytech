import { graphRequest, graphDownload } from './graph.js';

/** Paso 1: pedir la URL temporal del medio (caduca en minutos). */
export async function getMediaMeta(mediaId, accessToken) {
  return graphRequest({ path: mediaId, accessToken });
}

/** Paso 2: descargar el binario con el mismo token. */
export async function downloadMedia(mediaId, accessToken) {
  const meta = await getMediaMeta(mediaId, accessToken);
  if (!meta?.url) throw new Error(`Meta no devolvió URL para el medio ${mediaId}`);

  const file = await graphDownload(meta.url, accessToken);
  return {
    buffer: file.buffer,
    mimeType: meta.mime_type ?? file.contentType,
    sizeBytes: meta.file_size ?? file.contentLength,
    sha256: meta.sha256,
  };
}

/**
 * Sube un archivo a Meta para poder enviarlo por su id.
 * Usa FormData/Blob nativos de Node 20; axios los serializa como multipart.
 */
export async function uploadMedia({ phoneNumberId, accessToken, buffer, mimeType, filename }) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([buffer], { type: mimeType }), filename ?? 'archivo');

  const data = await graphRequest({
    method: 'POST',
    path: `${phoneNumberId}/media`,
    accessToken,
    data: form,
    timeout: 60000,
  });

  return { mediaId: data?.id ?? null };
}
