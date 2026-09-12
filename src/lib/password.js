import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;

/**
 * Hash de contraseña con scrypt de la librería estándar de Node.
 * Se evita bcrypt/argon2 a propósito: son módulos nativos y complican la
 * instalación en Windows y en las imágenes alpine de Railway.
 */
export async function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(plain, salt, KEYLEN);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;

  const derived = await scrypt(plain, salt, KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}
