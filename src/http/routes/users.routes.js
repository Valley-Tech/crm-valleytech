import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/http.js';
import { badRequest, notFound, forbidden } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAudit } from '../../services/audit.js';
import { invalidateAccess, metaIntegrationWhere, ROLE_LABEL, ALL_ROLES } from '../../services/access.js';

/**
 * Usuarios (antes "Equipo").
 *
 *  · superadmin → ve, crea, edita y elimina a todos; es el único que puede
 *                 crear otro superadmin o tocar a uno.
 *  · admin      → ve y gestiona a los usuarios de SUS números (los que
 *                 comparten algún número con él), y solo puede crear
 *                 dueños, agentes y lectores asignados a esos números.
 *  · owner y el resto no entran aquí (requireRole('admin')).
 */

const router = Router();
router.use(requireAuth, requireRole('admin'));

const ROLES_FOR_ADMIN = ['owner', 'agent', 'viewer'];

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
  lastLoginAt: true,
  createdAt: true,
  integrations: {
    select: {
      integration: { select: { id: true, displayPhoneNumber: true, verifiedName: true, active: true, bots: { where: { active: true }, select: { id: true, name: true } } } },
    },
  },
};

function serializeUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    roleLabel: ROLE_LABEL[u.role] ?? u.role,
    active: u.active,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    integrations: (u.integrations ?? []).map((r) => ({
      id: r.integration.id,
      displayPhoneNumber: r.integration.displayPhoneNumber,
      verifiedName: r.integration.verifiedName,
      active: r.integration.active,
      bots: r.integration.bots,
    })),
  };
}

const isSuper = (req) => req.auth.role === 'superadmin';

/** Usuarios que este administrador puede ver (superadmin: todos). */
function visibleUsersWhere(req) {
  const base = { tenantId: req.auth.tenantId };
  if (isSuper(req)) return base;
  return {
    ...base,
    role: { not: 'superadmin' },
    OR: [{ id: req.auth.userId }, { integrations: { some: { integrationId: { in: req.auth.scope.integrationIds } } } }],
  };
}

function assertRoleAllowed(req, role) {
  if (isSuper(req)) return;
  if (!ROLES_FOR_ADMIN.includes(role)) {
    throw forbidden(`Un administrador solo puede asignar los roles ${ROLES_FOR_ADMIN.map((r) => ROLE_LABEL[r]).join(', ')}`);
  }
}

/** Valida los números a asignar: existen en el cliente y están dentro del alcance de quien asigna. */
async function resolveIntegrationIds(req, ids, role) {
  const unique = [...new Set(ids ?? [])];
  if (role === 'superadmin') return []; // el superadmin lo ve todo, no necesita asignaciones
  if (unique.length === 0) throw badRequest('Asigna al menos un número de WhatsApp (chatbot) a este usuario');
  const found = await prisma.metaIntegration.findMany({
    where: { tenantId: req.auth.tenantId, id: { in: unique }, ...metaIntegrationWhere(req.auth.scope) },
    select: { id: true },
  });
  if (found.length !== unique.length) throw badRequest('Alguno de los números no existe o no está dentro de los que tú administras');
  return found.map((i) => i.id);
}

async function loadTarget(req) {
  const user = await prisma.user.findFirst({ where: { id: req.params.id, ...visibleUsersWhere(req) }, select: userSelect });
  if (!user) throw notFound('Usuario no encontrado');
  if (user.role === 'superadmin' && !isSuper(req)) throw forbidden('Solo un SuperAdmin puede modificar a otro SuperAdmin');
  return user;
}

// ---------------------------------------------------------------------------
router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const items = await prisma.user.findMany({ where: visibleUsersWhere(req), select: userSelect, orderBy: { createdAt: 'asc' } });
    res.json({ items: items.map(serializeUser) });
  })
);

/** Números (con su chatbot) y roles que quien pregunta puede asignar. */
router.get(
  '/users/options',
  asyncHandler(async (req, res) => {
    const integrations = await prisma.metaIntegration.findMany({
      where: { tenantId: req.auth.tenantId, ...metaIntegrationWhere(req.auth.scope) },
      select: { id: true, displayPhoneNumber: true, verifiedName: true, active: true, bots: { where: { active: true }, select: { id: true, name: true } } },
      orderBy: { connectedAt: 'asc' },
    });
    const roles = (isSuper(req) ? ALL_ROLES : ROLES_FOR_ADMIN).map((r) => ({ value: r, label: ROLE_LABEL[r] }));
    res.json({ integrations, roles });
  })
);

router.post(
  '/users',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        name: z.string().trim().min(2).max(80),
        email: z.string().email(),
        password: z.string().min(10, 'La contraseña debe tener al menos 10 caracteres'),
        role: z.enum(['superadmin', 'owner', 'admin', 'agent', 'viewer']).default('owner'),
        integrationIds: z.array(z.string().uuid()).max(50).default([]),
      })
      .parse(req.body);
    assertRoleAllowed(req, input.role);
    const integrationIds = await resolveIntegrationIds(req, input.integrationIds, input.role);

    const exists = await prisma.user.findFirst({ where: { tenantId: req.auth.tenantId, email: input.email.toLowerCase() }, select: { id: true } });
    if (exists) throw badRequest('Ya existe un usuario con ese correo');

    const user = await prisma.user.create({
      data: {
        tenantId: req.auth.tenantId,
        name: input.name,
        email: input.email.toLowerCase(),
        passwordHash: await hashPassword(input.password),
        role: input.role,
        integrations: { create: integrationIds.map((integrationId) => ({ integrationId })) },
      },
      select: userSelect,
    });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: 'user.create',
      entity: 'user',
      entityId: user.id,
      metadata: { email: user.email, role: user.role, integrations: integrationIds },
    });
    res.status(201).json(serializeUser(user));
  })
);

router.patch(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        name: z.string().trim().min(2).max(80).optional(),
        role: z.enum(['superadmin', 'owner', 'admin', 'agent', 'viewer']).optional(),
        active: z.boolean().optional(),
        password: z.string().min(10).optional(),
        integrationIds: z.array(z.string().uuid()).max(50).optional(),
      })
      .parse(req.body);

    const user = await loadTarget(req);

    // Nadie se quita a sí mismo el acceso ni el rol por accidente.
    if (user.id === req.auth.userId && (input.active === false || (input.role && input.role !== user.role))) {
      throw badRequest('No puedes cambiar tu propio rol ni desactivarte');
    }
    if (input.role) assertRoleAllowed(req, input.role);

    const role = input.role ?? user.role;
    let integrationIds;
    if (input.integrationIds !== undefined || (input.role && input.role !== user.role)) {
      const wanted = input.integrationIds ?? user.integrations.map((r) => r.integration.id);
      integrationIds = await resolveIntegrationIds(req, wanted, role);
    }

    const { password, integrationIds: _ignored, ...rest } = input;
    const updated = await prisma.$transaction(async (tx) => {
      if (integrationIds !== undefined) {
        await tx.userIntegration.deleteMany({ where: { userId: user.id } });
        if (integrationIds.length) {
          await tx.userIntegration.createMany({ data: integrationIds.map((integrationId) => ({ userId: user.id, integrationId })) });
        }
      }
      return tx.user.update({
        where: { id: user.id },
        data: { ...rest, ...(password ? { passwordHash: await hashPassword(password) } : {}) },
        select: userSelect,
      });
    });
    invalidateAccess(user.id);

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: 'user.update',
      entity: 'user',
      entityId: user.id,
      metadata: { ...rest, ...(integrationIds !== undefined ? { integrations: integrationIds } : {}), ...(password ? { password: 'cambiada' } : {}) },
    });

    res.json(serializeUser(updated));
  })
);

router.delete(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const user = await loadTarget(req);
    if (user.id === req.auth.userId) throw badRequest('No puedes eliminar tu propio usuario');
    // Chats asignados, mensajes enviados, notas y auditoría quedan sin autor (SET NULL).
    await prisma.user.delete({ where: { id: user.id } });
    invalidateAccess(user.id);
    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: 'user.delete',
      entity: 'user',
      entityId: user.id,
      metadata: { email: user.email, role: user.role },
    });
    res.json({ ok: true });
  })
);

export default router;
