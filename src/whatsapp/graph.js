import axios from 'axios';
import env from '../config/env.js';
import logger from '../lib/logger.js';
import { appSecretProof } from '../lib/signature.js';

export class MetaApiError extends Error {
  constructor(message, { status, code, subcode, details, requestId } = {}) {
    super(message);
    this.name = 'MetaApiError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.details = details;
    this.requestId = requestId;
  }

  /** ¿Tiene sentido reintentar? Límites de tasa y fallos temporales de Meta. */
  get isRetryable() {
    if (this.code === 130429 || this.code === 131056 || this.code === 4 || this.code === 80007) return true;
    return this.status === 429 || (this.status >= 500 && this.status <= 599);
  }

  /** Error 131047: ventana de servicio de 24 horas cerrada. */
  get isWindowClosed() {
    return this.code === 131047;
  }

  /** El token del cliente dejó de servir: hay que reconectar la integración. */
  get isAuthError() {
    return this.status === 401 || this.code === 190;
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalize(error) {
  const metaError = error.response?.data?.error;
  if (metaError) {
    return new MetaApiError(metaError.message ?? 'Error de la API de Meta', {
      status: error.response.status,
      code: metaError.code,
      subcode: metaError.error_subcode,
      details: metaError.error_data?.details ?? metaError.error_user_msg,
      requestId: error.response.headers?.['x-fb-trace-id'],
    });
  }
  return new MetaApiError(error.message, { status: error.response?.status });
}

/**
 * Llamada a la Graph API con reintentos y errores tipados.
 *
 * A diferencia del sendToWhatsApp original, nunca devuelve undefined en
 * silencio: o devuelve el cuerpo de la respuesta, o lanza un MetaApiError.
 */
export async function graphRequest({ method = 'GET', path, accessToken, data, params = {}, timeout = 20000 }) {
  const url = `${env.META_GRAPH_URL}/${env.META_API_VERSION}/${path}`;
  const query = { ...params, appsecret_proof: appSecretProof(accessToken) };

  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await axios({
        method,
        url,
        data,
        params: query,
        timeout,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      });
      return response.data;
    } catch (rawError) {
      lastError = normalize(rawError);
      const retryable = lastError.isRetryable || RETRYABLE_STATUS.has(rawError.response?.status);

      if (!retryable || attempt === MAX_ATTEMPTS) break;

      const waitMs = 2 ** (attempt - 1) * 1000;
      logger.warn({ path, attempt, waitMs, code: lastError.code }, 'Reintentando llamada a Meta');
      await sleep(waitMs);
    }
  }

  throw lastError;
}

/** Descarga binaria (usada para multimedia); devuelve un Buffer. */
export async function graphDownload(url, accessToken) {
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'arraybuffer',
    timeout: 60000,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return {
    buffer: Buffer.from(response.data),
    contentType: response.headers['content-type'],
    contentLength: Number(response.headers['content-length'] ?? response.data.byteLength),
  };
}
