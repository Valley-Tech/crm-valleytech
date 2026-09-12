import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { verifyPassword } from '../../lib/password.js';
import { unauthorized } from '../../lib/errors.js';
import { asyncHandler } from '../../lib/http.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../../services/audit.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findFirst({
      where: { email: email.toLowerCase(), active: true },
      include: { tenant: true },
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

    res.json({
      token: signToken(user),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        tenant: { id: user.tenant.id, name: user.tenant.name, plan: user.tenant.plan },
      },
    });
  })
);

router.get(
  '/auth/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.auth.userId },
      include: { tenant: true },
    });
    if (!user) throw unauthorized('El usuario ya no existe');

    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      tenant: { id: user.tenant.id, name: user.tenant.name, plan: user.tenant.plan },
    });
  })
);

export default router;
