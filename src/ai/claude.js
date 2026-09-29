import axios from 'axios';
import env from '../config/env.js';
import logger from '../lib/logger.js';

/**
 * Cliente mínimo de la API de Claude (Anthropic) por REST, sin SDK.
 *
 *  - messages: texto, imágenes y PDF como bloques de contenido.
 *  - Caché de prompt (prompt caching): el bloque de conocimiento del negocio
 *    se marca con cache_control y se cobra al 10 % en cada lectura, así una
 *    base de conocimiento de miles de tokens no encarece cada respuesta.
 *
 * Precios de referencia (sep-2026, USD por millón de tokens):
 *  Haiku 4.5  $1 / $5 · Sonnet 5.5  $2 / $10 · lectura de caché 0.1×.
 */

const API = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';

/** Modelos a probar en orden si el elegido no existe en la cuenta. */
export const CLAUDE_FALLBACKS = ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001'];

/** Opciones que se muestran en el CRM. */
export const CLAUDE_MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 · rápido y económico ($1 / $5 por millón)' },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 · más preciso ($2 / $10 por millón)' },
];

export class ClaudeError extends Error {
  constructor(message, { status, type, data } = {}) {
    super(message);
    this.name = 'ClaudeError';
    this.status = status;
    this.type = type;
    this.data = data;
  }
}

function apiKey(key) {
  const k = key || env.ANTHROPIC_API_KEY;
  if (!k) throw new ClaudeError('Falta ANTHROPIC_API_KEY: configúrala en el servidor para usar Claude.', { type: 'no_api_key' });
  return k;
}

async function call(body, { key, timeout = 90000 } = {}) {
  try {
    const response = await axios({
      method: 'POST',
      url: `${API}/messages`,
      data: body,
      timeout,
      headers: {
        'x-api-key': apiKey(key),
        'anthropic-version': VERSION,
        'content-type': 'application/json',
      },
      maxBodyLength: Infinity,
    });
    return response.data;
  } catch (err) {
    const data = err.response?.data;
    const e = data?.error;
    throw new ClaudeError(e?.message ? `Claude ${err.response.status}: ${e.message}` : err.message, {
      status: err.response?.status,
      type: e?.type,
      data,
    });
  }
}

const isModelNotFound = (err) => err.status === 404 || (err.type === 'not_found_error') || /model/i.test(err.message) && /not found|does not exist|unsupported/i.test(err.message);

/**
 * generate({ model, models, system, messages, maxTokens, temperature })
 *  system: string o array de bloques [{ type:'text', text, cache_control? }]
 *  messages: [{ role:'user'|'assistant', content: string | bloques }]
 * Devuelve { text, model, stopReason, usage, raw }.
 */
export async function generate({ model, models, system, messages, maxTokens = 1024, temperature = 0.4, key } = {}) {
  const candidates = [...new Set([model, env.CLAUDE_MODEL, ...(models ?? CLAUDE_FALLBACKS)].filter(Boolean))];
  let lastError;
  for (const candidate of candidates) {
    try {
      const raw = await call({
        model: candidate,
        max_tokens: maxTokens,
        temperature,
        ...(system ? { system } : {}),
        messages,
      }, { key });
      const text = (raw.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { text, model: raw.model ?? candidate, stopReason: raw.stop_reason, usage: raw.usage ?? {}, raw };
    } catch (err) {
      lastError = err;
      if (isModelNotFound(err) && candidates.length > 1) {
        logger.warn({ model: candidate, err: err.message }, 'Modelo de Claude no disponible; se prueba el siguiente');
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/** Bloque de documento PDF (base64) para un mensaje de usuario. */
export const pdfBlock = (buffer, title) => ({
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
  ...(title ? { title } : {}),
});

/** Bloque de imagen (base64). */
export const imageBlock = (buffer, mediaType) => ({
  type: 'image',
  source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') },
});

/** Bloque de texto plano de un documento (txt, md, csv, json, html ya convertido…). */
export const textDocumentBlock = (text, title) => ({
  type: 'document',
  source: { type: 'text', media_type: 'text/plain', data: text },
  ...(title ? { title } : {}),
});

export const CACHE_1H = { type: 'ephemeral', ttl: '1h' };
