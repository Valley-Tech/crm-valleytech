import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';

const router = Router();

/**
 * Healthcheck real: comprueba Postgres y Redis.
 * Railway lo usa para decidir si el despliegue quedó sano.
 */
router.get('/health', async (req, res) => {
  const checks = { database: 'down', redis: 'down' };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'up';
  } catch { /* queda en down */ }

  try {
    checks.redis = (await redis.ping()) === 'PONG' ? 'up' : 'down';
  } catch { /* queda en down */ }

  const healthy = Object.values(checks).every((value) => value === 'up');
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});

export default router;
