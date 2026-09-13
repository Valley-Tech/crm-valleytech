import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const schema = z.object({
  shortcut: z
    .string()
    .trim()
    .min(2)
    .max(30)
    .regex(/^[a-z0-9_-]+$/i, 'Solo letras, números, guion y guion bajo'),
  title: z.string().trim().min(2).max(80),
  body: z.string().trim().min(1).max(4096),
});

router.get(
  '/quick-replies',
  asyncHandler(async (req, res) => {
    const items = await prisma.quickReply.findMany({
      where: { tenantId: req.auth.tenantId },
      orderBy: { shortcut: 'asc' },
    });
    res.json({ items });
  })
);

router.post(
  '/quick-replies',
  requireRole('agent'),
  asyncHandler(async (req, res) => {
    const data = schema.parse(req.body);
    const created = await prisma.quickReply.create({
      data: { ...data, shortcut: data.shortcut.toLowerCase(), tenantId: req.auth.tenantId },
    });
    res.status(201).json(created);
  })
);

router.patch(
  '/quick-replies/:id',
  requireRole('agent'),
  asyncHandler(async (req, res) => {
    const data = schema.partial().parse(req.body);
    const existing = await prisma.quickReply.findFirst({ where: { id: req.params.id, tenantId: req.auth.tenantId } });
    if (!existing) throw notFound('Respuesta rápida no encontrada');
    if (data.shortcut) data.shortcut = data.shortcut.toLowerCase();
    res.json(await prisma.quickReply.update({ where: { id: existing.id }, data }));
  })
);

router.delete(
  '/quick-replies/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const existing = await prisma.quickReply.findFirst({ where: { id: req.params.id, tenantId: req.auth.tenantId } });
    if (!existing) throw notFound('Respuesta rápida no encontrada');
    await prisma.quickReply.delete({ where: { id: existing.id } });
    res.status(204).send();
  })
);

export default router;
