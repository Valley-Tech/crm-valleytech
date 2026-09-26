import { Router } from 'express';
import publicRoutes from './public.routes.js';
import authRoutes from './auth.routes.js';
import mediaRoutes from './media.routes.js';
import botRoutes from './bot.routes.js';
import conversationRoutes from './conversations.routes.js';
import templateRoutes from './templates.routes.js';
import quickReplyRoutes from './quickReplies.routes.js';
import metricsRoutes from './metrics.routes.js';
import campaignRoutes from './campaigns.routes.js';
import adminRoutes from './admin.routes.js';
import knowledgeRoutes from './knowledge.routes.js';

const router = Router();

/**
 * El orden importa: los routers con router.use(requireAuth) aplican su
 * autenticación a TODO lo que pase por /api, así que las rutas públicas y las
 * que se autentican de otra forma (bots por X-Bot-Key, media por ?token=)
 * van primero.
 */
router.use(publicRoutes);
router.use('/api/v1/bot', botRoutes);
router.use('/api', authRoutes);
router.use('/api', mediaRoutes);
router.use('/api', conversationRoutes);
router.use('/api', templateRoutes);
router.use('/api', quickReplyRoutes);
router.use('/api', metricsRoutes);
router.use('/api', campaignRoutes);
router.use('/api', adminRoutes);
router.use('/api', knowledgeRoutes);

export default router;
