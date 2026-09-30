import crypto from 'node:crypto';
import axios from 'axios';

/**
 * Cliente S3 mínimo sin dependencias (AWS Signature V4 sobre HTTPS).
 *
 * Cubre lo único que el CRM necesita —PutObject, GetObject, DeleteObject— para
 * no arrastrar el SDK de AWS (decenas de paquetes y un package-lock que hay
 * que regenerar). Funciona con Amazon S3 y con servicios compatibles
 * (Cloudflare R2, Backblaze B2, MinIO) usando `endpoint` con rutas por bucket.
 */

const SERVICE = 's3';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Codificación de URI que exige S3: todo salvo A-Z a-z 0-9 - _ . ~ (y "/" en la ruta). */
export function encodeKey(key) {
  return String(key)
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

export function amzDate(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * Firma una petición (SigV4). Devuelve las cabeceras a enviar, incluida Authorization.
 * headers: { host, 'x-amz-date', 'x-amz-content-sha256', ... } en minúsculas.
 */
export function signRequest({ method, path, query = '', headers, accessKeyId, secretAccessKey, region, date }) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const signedHeaders = Object.keys(lower).sort();
  const canonicalHeaders = signedHeaders.map((k) => `${k}:${lower[k]}\n`).join('');
  const payloadHash = lower['x-amz-content-sha256'];
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders.join(';'), payloadHash].join('\n');

  const dateStamp = date.slice(0, 8);
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
  };
}

export class S3Lite {
  constructor({ bucket, region, accessKeyId, secretAccessKey, endpoint = '' }) {
    if (!bucket) throw new Error('S3: falta el bucket');
    if (!accessKeyId || !secretAccessKey) throw new Error('S3: faltan AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY');
    this.bucket = bucket;
    this.region = region || 'us-east-1';
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.endpoint = endpoint ? endpoint.replace(/\/$/, '') : '';
  }

  /** URL y ruta canónica del objeto: virtual-hosted en AWS, path-style con endpoint propio. */
  target(key) {
    const encoded = encodeKey(key);
    if (this.endpoint) {
      const url = new URL(this.endpoint);
      return { host: url.host, path: `/${this.bucket}/${encoded}`, url: `${this.endpoint}/${this.bucket}/${encoded}` };
    }
    const host = `${this.bucket}.s3.${this.region}.amazonaws.com`;
    return { host, path: `/${encoded}`, url: `https://${host}/${encoded}` };
  }

  async request(method, key, { body, contentType, responseType } = {}) {
    const { host, path, url } = this.target(key);
    const date = amzDate();
    const headers = {
      host,
      'x-amz-content-sha256': body ? sha256Hex(body) : EMPTY_SHA256,
      'x-amz-date': date,
      ...(contentType ? { 'content-type': contentType } : {}),
    };
    const signed = signRequest({ method, path, headers, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey, region: this.region, date });
    const { host: _omit, ...sendHeaders } = signed; // axios pone Host por su cuenta
    try {
      return await axios({ method, url, data: body, headers: sendHeaders, responseType: responseType ?? 'arraybuffer', timeout: 120000, maxBodyLength: Infinity, maxContentLength: Infinity });
    } catch (err) {
      const status = err.response?.status;
      const raw = err.response?.data;
      const text = raw == null ? err.message
        : Buffer.isBuffer(raw) || raw instanceof ArrayBuffer ? Buffer.from(raw).toString('utf8').slice(0, 400)
        : typeof raw === 'string' ? raw.slice(0, 400) : JSON.stringify(raw).slice(0, 400);
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
      const e = new Error(`S3 ${status ?? ''} ${code ?? ''}: ${/<Message>([^<]+)<\/Message>/.exec(text)?.[1] ?? text}`.trim());
      e.status = status;
      e.code = code === 'NoSuchKey' ? 'ENOENT' : code;
      throw e;
    }
  }

  async put(key, buffer, contentType = 'application/octet-stream') {
    await this.request('PUT', key, { body: buffer, contentType });
    return key;
  }

  async get(key) {
    const response = await this.request('GET', key);
    return Buffer.from(response.data);
  }

  async delete(key) {
    await this.request('DELETE', key);
    return true;
  }
}
