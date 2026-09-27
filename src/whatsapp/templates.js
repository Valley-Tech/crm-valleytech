import axios from 'axios';
import env from '../config/env.js';
import { graphRequest, MetaApiError } from './graph.js';
import { resolveCredentials } from './credentials.js';

/** Lista todas las plantillas de una WABA, paginando hasta el final. */
export async function listTemplates(wabaId, accessToken) {
  const collected = [];
  let after;

  do {
    const page = await graphRequest({
      path: `${wabaId}/message_templates`,
      accessToken,
      params: { limit: 100, ...(after ? { after } : {}) },
    });
    collected.push(...(page?.data ?? []));
    after = page?.paging?.cursors?.after && page?.paging?.next ? page.paging.cursors.after : null;
  } while (after);

  return collected;
}

/**
 * Crea una plantilla en la WABA (queda "pendiente" hasta que Meta la revise).
 * `template` = { name, language, category, components, allow_category_change }.
 * Devuelve { id, status, category }.
 */
export async function createTemplate(wabaId, accessToken, template) {
  return graphRequest({
    method: 'POST',
    path: `${wabaId}/message_templates`,
    accessToken,
    data: template,
    timeout: 30000,
  });
}

/** Borra una plantilla por nombre (todas sus variantes de idioma) o por id + nombre. */
export async function deleteTemplate(wabaId, accessToken, { name, id }) {
  return graphRequest({
    method: 'DELETE',
    path: `${wabaId}/message_templates`,
    accessToken,
    params: { name, ...(id ? { hsm_id: id } : {}) },
  });
}

/**
 * Sube el archivo de ejemplo de una cabecera multimedia (imagen, video, PDF)
 * con la Resumable Upload API y devuelve el "handle" que pide Meta en
 * components[].example.header_handle. Se sube contra la app dueña del token.
 */
export async function uploadTemplateExample({ appId, accessToken, buffer, mimeType, filename }) {
  const credentials = resolveCredentials(accessToken);
  const base = `${env.META_GRAPH_URL}/${env.META_API_VERSION}`;

  const session = await graphRequest({
    method: 'POST',
    path: `${appId ?? credentials.appId ?? env.META_APP_ID}/uploads`,
    accessToken: credentials,
    params: { file_length: buffer.length, file_type: mimeType, file_name: filename ?? 'ejemplo' },
  });
  if (!session?.id) throw new MetaApiError('Meta no abrió la sesión de subida del archivo de ejemplo');

  try {
    const response = await axios({
      method: 'POST',
      url: `${base}/${session.id}`,
      data: buffer,
      timeout: 120000,
      maxBodyLength: Infinity,
      headers: {
        Authorization: `OAuth ${credentials.accessToken}`,
        file_offset: '0',
        'Content-Type': 'application/octet-stream',
      },
    });
    if (!response.data?.h) throw new MetaApiError('Meta no devolvió el identificador del archivo de ejemplo');
    return { handle: response.data.h };
  } catch (err) {
    if (err instanceof MetaApiError) throw err;
    const meta = err.response?.data?.error;
    throw new MetaApiError(meta?.message ?? err.message, { status: err.response?.status, code: meta?.code });
  }
}
