import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { verifyPassword } from '../../lib/password.js';
import { unauthorized } from '../../lib/errors.js';
import { asyncHandler } from '../../lib/http.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../../services/audit.js';
import { ROLE_LABEL } from '../../services/access.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * Perfil que ve el frontend: rol y, para quien no es superadmin, los números
 * (con su chatbot) que administra. La interfaz lo usa para el menú, el
 * encabezado ("Estás administrando SamuelitoBot") y los selectores.
 */
export async function profileOf(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      tenant: true,
      integrations: {
        include: {
          integration: {
            select: { id: true, displayPhoneNumber: true, verifiedName: true, active: true, bots: { where: { active: true }, select: { id: true, name: true } } },
          },
        },
      },
    },
  });
  if (!user) return null;
  const all = user.role === 'superadmin';
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    roleLabel: ROLE_LABEL[user.role] ?? user.role,
    tenant: { id: user.tenant.id, name: user.tenant.name, plan: user.tenant.plan },
    scope: {
      all,
      integrations: all
        ? []
        : user.integrations.map((r) => ({
            id: r.integration.id,
            displayPhoneNumber: r.integration.displayPhoneNumber,
            verifiedName: r.integration.verifiedName,
            active: r.integration.active,
            bots: r.integration.bots,
          })),
    },
  };
}

router.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findFirst({
      where: { email: email.toLowerCase(), active: true },
    });

    // Mismo mensaje en ambos casos para no revelar qué correos existen.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw unauthorized('Correo o contraseña incorrectos');
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await recordAudit({
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: 'auth.login',
      entity: 'user',
      entityId: user.id,
    });

    res.json({ token: signToken(user), user: await profileOf(user.id) });
  })
);

router.get(
  '/auth/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const profile = await profileOf(req.auth.userId);
    if (!profile) throw unauthorized('El usuario ya no existe');
    res.json(profile);
  })
);

export default router;
