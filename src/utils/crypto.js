import crypto from 'node:crypto';
import config from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(config.CREDENTIALS_ENCRYPTION_KEY, 'base64');

/**
 * Cifra un texto plano (ej. un access token de Meta) para guardarlo en base de datos.
 * Devuelve un string "iv:authTag:ciphertext" en base64, todo junto para simplificar el storage.
 */
export function encryptSecret(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

/**
 * Descifra un valor generado por encryptSecret.
 */
export function decryptSecret(encoded) {
  const [ivB64, authTagB64, dataB64] = encoded.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

  return decrypted.toString('utf8');
}
