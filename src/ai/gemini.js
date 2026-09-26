import axios from 'axios';
import env from '../config/env.js';
import logger from '../lib/logger.js';

/**
 * Cliente mínimo de la API de Gemini por REST (sin SDK):
 *  - generateContent (texto, visión, con o sin File Search)
 *  - File Search: almacenes, subida de documentos, listado, borrado
 *
 * Se usa REST y no @google/genai para no añadir dependencias y para que el
 * mismo archivo sirva tal cual dentro de los bots.
 */

const BASE = 'https://generativelanguage.googleapis.com';
const API = `${BASE}/v1beta`;
const UPLOAD = `${BASE}/upload/v1beta`;

/** Modelos a probar en orden: si el primero no existe en la cuenta, se pasa al siguiente. */
export const MODEL_FALLBACKS = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash'];

export class GeminiError extends Error {
  constructor(message, { status, code, data } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

function apiKey(key) {
  const k = key || env.GEMINI_API_KEY;
  if (!k) throw new GeminiError('Falta GEMINI_API_KEY: configúrala en el servidor para usar la IA.', { code: 'no_api_key' });
  return k;
}

async function call(method, url, { key, data, headers = {}, params = {}, timeout = 60000, responseType } = {}) {
  try {
    const response = await axios({
      method,
      url,
      data,
      headers,
      params: { key: apiKey(key), ...params },
      timeout,
      responseType,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return response;
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    const message = body?.error?.message ?? err.message;
    throw new GeminiError(`Gemini ${status ?? ''}: ${message}`.trim(), { status, code: body?.error?.status, data: body });
  }
}

// ---------------------------------------------------------------------------
//  Generación
// ---------------------------------------------------------------------------

/**
 * generateContent con reintento por modelo. `contents` en formato Gemini
 * ([{ role: 'user'|'model', parts: [{ text }] }]).
 */
export async function generate({
  model,
  models,
  systemInstruction,
  contents,
  tools,
  generationConfig = {},
  key,
  timeout = 60000,
}) {
  const candidates = [...new Set([model, ...(models ?? []), ...MODEL_FALLBACKS].filter(Boolean))];
  let lastError = null;

  for (const name of candidates) {
    const body = {
      contents,
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      ...(tools?.length ? { tools } : {}),
      generationConfig: { temperature: 0.4, maxOutputTokens: 1024, ...generationConfig },
    };
    try {
      const { data } = await call('POST', `${API}/models/${name}:generateContent`, { key, data: body, timeout });
      const candidate = data.candidates?.[0];
      const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
      const grounding = candidate?.groundingMetadata ?? null;
      const sources = [...new Set((grounding?.groundingChunks ?? []).map((c) => c.retrievedContext?.title ?? c.web?.title).filter(Boolean))];
      return { text, model: name, finishReason: candidate?.finishReason, sources, raw: data };
    } catch (err) {
      lastError = err;
      // 404 = ese modelo no existe (todavía / ya no) para esta cuenta: probar el siguiente.
      if (err.status === 404 || /not found|not supported/i.test(err.message)) {
        logger.warn({ model: name, err: err.message }, 'Modelo de Gemini no disponible, probando el siguiente');
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new GeminiError('Ningún modelo de Gemini disponible');
}

/** Describe una imagen (OCR + descripción) para poder indexarla como texto. */
export async function describeImage({ buffer, mimeType, name = 'imagen', key, model }) {
  const prompt =
    `Describe esta imagen en español para una base de conocimiento de un negocio. ` +
    `Transcribe TODO el texto visible tal cual (precios, nombres, tallas, teléfonos, direcciones, promociones). ` +
    `Luego describe lo que se ve (productos, colores, diseño). Devuelve Markdown con un título "# ${name}".`;
  const { text } = await generate({
    model,
    key,
    contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType, data: buffer.toString('base64') } }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    timeout: 90000,
  });
  return text;
}

// ---------------------------------------------------------------------------
//  File Search (almacenes de documentos con búsqueda semántica gestionada)
// ---------------------------------------------------------------------------

export async function createStore(displayName, { key } = {}) {
  const { data } = await call('POST', `${API}/fileSearchStores`, { key, data: { displayName } });
  return data; // { name: 'fileSearchStores/xxx', displayName, ... }
}

export async function getStore(storeName, { key } = {}) {
  const { data } = await call('GET', `${API}/${storeName}`, { key });
  return data;
}

export async function deleteStore(storeName, { key } = {}) {
  await call('DELETE', `${API}/${storeName}`, { key, params: { force: true } });
}

export async function listDocuments(storeName, { key } = {}) {
  const documents = [];
  let pageToken;
  do {
    const { data } = await call('GET', `${API}/${storeName}/documents`, { key, params: { pageSize: 100, ...(pageToken ? { pageToken } : {}) } });
    documents.push(...(data.documents ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return documents;
}

export async function deleteDocument(documentName, { key } = {}) {
  try {
    await call('DELETE', `${API}/${documentName}`, { key, params: { force: true } });
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

export async function getOperation(operationName, { key } = {}) {
  const { data } = await call('GET', `${API}/${operationName}`, { key });
  return data;
}

export async function waitOperation(operation, { key, timeoutMs = 10 * 60 * 1000, intervalMs = 3000 } = {}) {
  let current = operation;
  const started = Date.now();
  while (!current.done) {
    if (Date.now() - started > timeoutMs) throw new GeminiError('La indexación en Gemini tardó demasiado', { code: 'timeout' });
    await new Promise((r) => setTimeout(r, intervalMs));
    current = await getOperation(current.name, { key });
  }
  if (current.error) throw new GeminiError(`Indexación fallida: ${current.error.message ?? JSON.stringify(current.error)}`, { data: current.error });
  return current;
}

/**
 * Sube un archivo directamente al almacén (protocolo resumable en dos pasos)
 * y espera a que quede indexado. Devuelve el nombre del documento.
 */
export async function uploadToStore(storeName, { buffer, mimeType, displayName, metadata = {}, chunking, key }) {
  const start = await call('POST', `${UPLOAD}/${storeName}:uploadToFileSearchStore`, {
    key,
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buffer.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    data: {
      displayName,
      ...(Object.keys(metadata).length
        ? { customMetadata: Object.entries(metadata).map(([k, v]) => (typeof v === 'number' ? { key: k, numericValue: v } : { key: k, stringValue: String(v) })) }
        : {}),
      ...(chunking ? { chunkingConfig: { whiteSpaceConfig: chunking } } : {}),
    },
  });
  const uploadUrl = start.headers['x-goog-upload-url'];
  if (!uploadUrl) throw new GeminiError('Gemini no devolvió la URL de subida');

  const finish = await axios({
    method: 'POST',
    url: uploadUrl,
    data: buffer,
    headers: {
      'Content-Length': String(buffer.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    maxBodyLength: Infinity,
    timeout: 5 * 60 * 1000,
  }).catch((err) => {
    throw new GeminiError(`Subida a Gemini fallida: ${err.response?.data?.error?.message ?? err.message}`, { status: err.response?.status });
  });

  const operation = await waitOperation(finish.data, { key });
  const documentName =
    operation.response?.documentName ??
    operation.response?.document?.name ??
    operation.response?.name ??
    (await findDocumentByDisplayName(storeName, displayName, { key }));
  return { documentName, operation };
}

async function findDocumentByDisplayName(storeName, displayName, { key } = {}) {
  const docs = await listDocuments(storeName, { key });
  return docs.find((d) => d.displayName === displayName)?.name ?? null;
}

/** Herramienta File Search para generateContent. */
export function fileSearchTool(storeNames) {
  const names = (Array.isArray(storeNames) ? storeNames : [storeNames]).filter(Boolean);
  return names.length ? [{ fileSearch: { fileSearchStoreNames: names } }] : [];
}

/** Tipos que Gemini File Search indexa directamente (sin convertir). */
export const NATIVE_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/json',
  'application/xml',
  'text/xml',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/rtf',
  'text/rtf',
]);

export const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export function mimeFromName(name = '', fallback = 'application/octet-stream') {
  const ext = name.toLowerCase().split('.').pop();
  const map = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    json: 'application/json',
    xml: 'application/xml',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
    rtf: 'application/rtf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  return map[ext] ?? fallback;
}
