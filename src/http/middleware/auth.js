import jwt from 'jsonwebtoken';
import env from '../../config/env.js';
import prisma from '../../lib/prisma.js';
import { hashApiKey } from '../../lib/crypto.js';
import { unauthorized, forbidden } from '../../lib/errors.js';

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, tenantId: user.tenantId, role: user.role, email: user.email, name: user.name },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN }
  );
}

/** Autenticación de agentes y administradores del CRM. */
export function requireAuth(req, res, next) {
  const header = req.get('Authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) return next(unauthorized('Falta la cabecera Authorization'));

  try {
    const claims = jwt.verify(token, env.JWT_SECRET);
    req.auth = { userId: claims.sub, tenantId: claims.tenantId, role: claims.role, email: claims.email };
    next();
  } catch {
    next(unauthorized('Sesión inválida o expirada'));
  }
}

/**
 * Igual que requireAuth, pero acepta además ?token= en la URL.
 *
 * Se usa SOLO para descargar multimedia: una etiqueta <img src> no puede
 * enviar la cabecera Authorization. No la uses en rutas que escriben.
 */
export function requireAuthAllowQueryToken(req, res, next) {
  if (req.get('Authorization')) return requireAuth(req, res, next);

  const token = req.query?.token;
  if (!token) return next(unauthorized('Falta el token'));

  try {
    const claims = jwt.verify(String(token), env.JWT_SECRET);
    req.auth = { userId: claims.sub, tenantId: claims.tenantId, role: claims.role, email: claims.email };
    next();
  } catch {
    next(unauthorized('Sesión inválida o expirada'));
  }
}

const ROLE_ORDER = { viewer: 0, agent: 1, admin: 2, owner: 3 };

/** Exige un rol mínimo. requireRole('admin') deja pasar a admin y owner. */
export function requireRole(minimum) {
  return (req, res, next) => {
    const current = ROLE_ORDER[req.auth?.role] ?? -1;
    if (current < (ROLE_ORDER[minimum] ?? 99)) {
      return next(forbidden(`Se requiere el rol ${minimum} o superior`));
    }
    next();
  };
}

/**
 * Autenticación de chatbots externos.
 * La API key viaja en X-Bot-Key y en base de datos solo se guarda su hash.
 */
export async function requireBot(req, res, next) {
  try {
    const raw = req.get('X-Bot-Key');
    if (!raw) return next(unauthorized('Falta la cabecera X-Bot-Key'));

    const bot = await prisma.botIntegration.findUnique({
      where: { apiKeyHash: hashApiKey(raw) },
      include: { tenant: true },
    });

    if (!bot || !bot.active) return next(unauthorized('API key de bot inválida o inactiva'));

    req.bot = bot;
    req.auth = { tenantId: bot.tenantId, role: 'bot' };
    next();
  } catch (err) {
    next(err);
  }
}
