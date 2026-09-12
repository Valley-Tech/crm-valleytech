import crypto from 'node:crypto';
import env from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
// env.js ya validó que decodifica a exactamente 32 bytes.
const KEY = Buffer.from(env.CREDENTIALS_ENCRYPTION_KEY, 'base64');

/**
 * Cifra un secreto (token de Meta, secreto de firma de un bot) para guardarlo
 * en base de datos. Formato: "iv:authTag:ciphertext", todo en base64.
 */
export function encryptSecret(plainText) {
  if (typeof plainText !== 'string' || plainText.length === 0) {
    throw new Error('encryptSecret requiere una cadena no vacía');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

/** Descifra un valor producido por encryptSecret. */
export function decryptSecret(encoded) {
  if (typeof encoded !== 'string') throw new Error('decryptSecret requiere una cadena');
  const parts = encoded.split(':');
  if (parts.length !== 3) throw new Error('Secreto cifrado con formato inválido');

  const [ivB64, authTagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** Compara dos cadenas en tiempo constante sin lanzar si difieren en longitud. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Genera una API key legible y su hash para guardar. */
export function generateApiKey(prefix = 'vtk') {
  const raw = `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, prefix.length + 7) };
}

export function hashApiKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}
