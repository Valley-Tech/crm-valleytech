import jwt from 'jsonwebtoken';
import env from '../../config/env.js';
import prisma from '../../lib/prisma.js';
import { hashApiKey } from '../../lib/crypto.js';
import { unauthorized, forbidden } from '../../lib/errors.js';
import { loadAccess, roleAtLeast, ROLE_LABEL } from '../../services/access.js';

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, tenantId: user.tenantId, role: user.role, email: user.email, name: user.name },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN }
  );
}

/**
 * Verifica el JWT y carga el alcance del usuario desde la base de datos
 * (rol vigente, números asignados). Así un cambio de rol, una asignación nueva
 * o una desactivación se aplican de inmediato, sin esperar a un nuevo login.
 */
async function authenticate(token) {
  let claims;
  try {
    claims = jwt.verify(String(token), env.JWT_SECRET);
  } catch {
    throw unauthorized('Sesión inválida o expirada');
  }
  const access = await loadAccess(claims.sub);
  if (!access || access.tenantId !== claims.tenantId) throw unauthorized('Tu usuario ya no tiene acceso; inicia sesión de nuevo');
  return { userId: access.userId, tenantId: access.tenantId, role: access.role, email: access.email, name: access.name, scope: access.scope };
}

/** Autenticación de agentes y administradores del CRM. */
export function requireAuth(req, res, next) {
  const header = req.get('Authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorized('Falta la cabecera Authorization'));

  authenticate(token)
    .then((auth) => { req.auth = auth; next(); })
    .catch(next);
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

  authenticate(token)
    .then((auth) => { req.auth = auth; next(); })
    .catch(next);
}

/**
 * Exige un rol mínimo. Orden: viewer < agent < owner (Dueño) < admin
 * (Administrador) < superadmin. requireRole('admin') deja pasar a admin y superadmin.
 */
export function requireRole(minimum) {
  return (req, res, next) => {
    if (!roleAtLeast(req.auth?.role, minimum)) {
      return next(forbidden(`Se requiere el rol ${ROLE_LABEL[minimum] ?? minimum} o superior`));
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
    req.auth = { tenantId: bot.tenantId, role: 'bot', scope: { all: true, integrationIds: null, wabaIds: null } };
    next();
  } catch (err) {
    next(err);
  }
}
