import prisma from '../lib/prisma.js';

/**
 * Alcance de cada usuario: qué números de WhatsApp (y por tanto qué chatbots)
 * puede ver.
 *
 *  · superadmin → todo el cliente (scope.all = true).
 *  · resto      → solo los números asignados en Usuarios (user_integrations).
 *                 Sin asignaciones no ve ninguna conversación, contacto,
 *                 campaña ni plantilla: mejor vacío que de más.
 *
 * Se consulta en cada petición (con una caché corta) para que un cambio de
 * rol, de números o una desactivación surtan efecto sin esperar a que caduque
 * el JWT.
 */

export const ROLE_ORDER = { viewer: 0, agent: 1, owner: 2, admin: 3, superadmin: 4 };
export const ROLE_LABEL = { superadmin: 'SuperAdmin', owner: 'Dueño', admin: 'Administrador', agent: 'Agente', viewer: 'Lector' };
export const ALL_ROLES = Object.keys(ROLE_ORDER);

export const roleAtLeast = (role, minimum) => (ROLE_ORDER[role] ?? -1) >= (ROLE_ORDER[minimum] ?? 99);

const TTL_MS = 15_000;
const cache = new Map(); // userId → { at, value }

export function invalidateAccess(userId) {
  if (userId) cache.delete(userId);
  else cache.clear();
}

/** Devuelve null si el usuario ya no existe o está desactivado. */
export async function loadAccess(userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      tenantId: true,
      role: true,
      active: true,
      email: true,
      name: true,
      integrations: { select: { integration: { select: { id: true, wabaId: true } } } },
    },
  });
  if (!user || !user.active) {
    cache.delete(userId);
    return null;
  }

  const all = user.role === 'superadmin';
  const integrationIds = all ? null : user.integrations.map((r) => r.integration.id);
  const wabaIds = all ? null : [...new Set(user.integrations.map((r) => r.integration.wabaId))];
  const value = {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    email: user.email,
    name: user.name,
    scope: { all, integrationIds, wabaIds },
  };
  cache.set(userId, { at: Date.now(), value });
  return value;
}

/* ----------------------------------------------------- filtros de consulta */

/** ¿Puede este usuario ver el número indicado? (null = chat sin número: solo superadmin) */
export function canSeeIntegration(scope, integrationId) {
  if (scope.all) return true;
  if (!integrationId) return false;
  return scope.integrationIds.includes(integrationId);
}

export function canSeeWaba(scope, wabaId) {
  return scope.all || scope.wabaIds.includes(wabaId);
}

/** where para conversaciones y campañas (tienen integrationId). */
export function integrationWhere(scope) {
  return scope.all ? {} : { integrationId: { in: scope.integrationIds } };
}

/** where para contactos: los que tienen algún chat por un número visible. */
export function contactWhere(scope) {
  return scope.all ? {} : { conversations: { some: { integrationId: { in: scope.integrationIds } } } };
}

/** where para mensajes (van por la conversación). */
export function messageWhere(scope) {
  return scope.all ? {} : { conversation: { integrationId: { in: scope.integrationIds } } };
}

/** where para plantillas (son de la WABA del número). */
export function templateWhere(scope) {
  return scope.all ? {} : { wabaId: { in: scope.wabaIds } };
}

/** where para números de WhatsApp. */
export function metaIntegrationWhere(scope) {
  return scope.all ? {} : { id: { in: scope.integrationIds } };
}

/** where para chatbots: los del número visible (o los que atienden todos). */
export function botWhere(scope) {
  return scope.all ? {} : { OR: [{ metaIntegrationId: { in: scope.integrationIds } }, { metaIntegrationId: null }] };
}
