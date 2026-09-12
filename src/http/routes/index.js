import { Router } from 'express';
import authRoutes from './auth.routes.js';
import mediaRoutes from './media.routes.js';
import conversationRoutes from './conversations.routes.js';
import adminRoutes from './admin.routes.js';
import botRoutes from './bot.routes.js';

const router = Router();

/**
 * El orden importa.
 *
 * conversationRoutes y adminRoutes aplican su middleware de autenticación a
 * TODO lo que entra por /api (así funciona router.use en Express), así que las
 * rutas con otra forma de autenticarse van primero:
 *   · /api/v1/bot   se autentica con X-Bot-Key, no con JWT
 *   · /api/media    acepta el token por querystring
 * Si fueran después, el requireAuth de conversationRoutes las cortaría con 401.
 */
router.use('/api/v1/bot', botRoutes);
router.use('/api', authRoutes);
router.use('/api', mediaRoutes);
router.use('/api', conversationRoutes);
router.use('/api', adminRoutes);

export default router;
