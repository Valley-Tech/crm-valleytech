import { Router } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/http.js';
import { badRequest } from '../../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { integrationWhere, messageWhere, contactWhere, metaIntegrationWhere, canSeeIntegration } from '../../services/access.js';
import { forbidden } from '../../lib/errors.js';

const router = Router();
router.use(requireAuth);

function parseRange(query) {
  const to = query.to ? new Date(String(query.to)) : new Date();
  const from = query.from ? new Date(String(query.from)) : new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequest('Fechas inválidas (usa ISO)');
  return { from, to };
}

/**
 * Métricas del panel. Todo parte del tenant del token, del alcance del usuario
 * (sus números) y del rango pedido. ?integrationId= limita a un solo número.
 * Las series diarias van por SQL crudo: es la forma natural de agrupar por día.
 */
router.get(
  '/metrics/overview',
  asyncHandler(async (req, res) => {
    const tenantId = req.auth.tenantId;
    const { from, to } = parseRange(req.query);

    // Números que entran en el cálculo: los del usuario (o todos), o uno concreto.
    const only = req.query.integrationId ? String(req.query.integrationId) : null;
    if (only && !canSeeIntegration(req.auth.scope, only)) throw forbidden('Ese número no está entre los que administras');
    const scope = only ? { all: false, integrationIds: [only], wabaIds: [] } : req.auth.scope;
    const convW = integrationWhere(scope);
    const msgW = messageWhere(scope);
    const contactW = contactWhere(scope);
    // Para el SQL crudo: lista de ids o NULL (= sin filtro).
    const ids = scope.all ? null : scope.integrationIds;
    const idFilter = ids
      ? Prisma.sql`AND c.integration_id IN (${ids.length ? Prisma.join(ids) : Prisma.sql`NULL`})`
      : Prisma.empty;

    const [
      conversationsTotal,
      conversationsOpen,
      conversationsPending,
      messagesIn,
      messagesOut,
      contactsTotal,
      newContacts,
      byStatus,
      byStage,
      byAgent,
      daily,
      firstResponse,
      templateUsage,
      integrations,
    ] = await Promise.all([
      prisma.conversation.count({ where: { tenantId, ...convW, createdAt: { gte: from, lte: to } } }),
      prisma.conversation.count({ where: { tenantId, ...convW, status: 'open' } }),
      prisma.conversation.count({ where: { tenantId, ...convW, status: 'pending' } }),
      prisma.message.count({ where: { tenantId, ...msgW, direction: 'inbound', createdAt: { gte: from, lte: to } } }),
      prisma.message.count({ where: { tenantId, ...msgW, direction: 'outbound', createdAt: { gte: from, lte: to } } }),
      prisma.contact.count({ where: { tenantId, ...contactW } }),
      prisma.contact.count({ where: { tenantId, ...contactW, createdAt: { gte: from, lte: to } } }),
      prisma.conversation.groupBy({ by: ['status'], where: { tenantId, ...convW }, _count: { _all: true } }),
      prisma.conversation.groupBy({ by: ['pipelineStage'], where: { tenantId, ...convW }, _count: { _all: true } }),
      prisma.message.groupBy({
        by: ['sentByUserId'],
        where: { tenantId, ...msgW, direction: 'outbound', source: 'agent', createdAt: { gte: from, lte: to } },
        _count: { _all: true },
      }),
      prisma.$queryRaw(Prisma.sql`
        SELECT
          to_char(date_trunc('day', m.created_at), 'YYYY-MM-DD') AS day,
          SUM(CASE WHEN m.direction = 'inbound'  THEN 1 ELSE 0 END)::int AS inbound,
          SUM(CASE WHEN m.direction = 'outbound' THEN 1 ELSE 0 END)::int AS outbound
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.tenant_id = ${tenantId} AND m.created_at >= ${from} AND m.created_at <= ${to} ${idFilter}
        GROUP BY 1 ORDER BY 1
      `),
      prisma.$queryRaw(Prisma.sql`
        SELECT
          AVG(EXTRACT(EPOCH FROM (o.first_out - i.first_in)))::float AS avg_seconds,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (o.first_out - i.first_in)))::float AS median_seconds,
          COUNT(*)::int AS answered
        FROM (
          SELECT m.conversation_id, MIN(m.created_at) AS first_in
          FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          WHERE m.tenant_id = ${tenantId} AND m.direction = 'inbound' AND m.created_at >= ${from} AND m.created_at <= ${to} ${idFilter}
          GROUP BY m.conversation_id
        ) i
        JOIN (
          SELECT conversation_id, MIN(created_at) AS first_out
          FROM messages
          WHERE tenant_id = ${tenantId} AND direction = 'outbound' AND source = 'agent'
          GROUP BY conversation_id
        ) o ON o.conversation_id = i.conversation_id
        WHERE o.first_out > i.first_in
      `),
      prisma.usageEvent.groupBy({
        by: ['category'],
        where: { tenantId, kind: 'template_message', occurredAt: { gte: from, lte: to }, ...(scope.all ? {} : { conversation: integrationWhere(scope) }) },
        _sum: { quantity: true },
      }),
      prisma.metaIntegration.findMany({
        where: { tenantId, ...metaIntegrationWhere(scope) },
        select: { id: true, displayPhoneNumber: true, verifiedName: true, qualityRating: true, messagingTier: true, active: true, isCoexistence: true, bots: { where: { active: true }, select: { id: true, name: true } } },
        orderBy: { connectedAt: 'asc' },
      }),
    ]);

    const agentIds = byAgent.map((row) => row.sentByUserId).filter(Boolean);
    const agents = agentIds.length
      ? await prisma.user.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } })
      : [];
    const agentName = (id) => agents.find((a) => a.id === id)?.name ?? 'Sin asignar';

    res.json({
      range: { from, to },
      totals: {
        conversations: conversationsTotal,
        open: conversationsOpen,
        pending: conversationsPending,
        messagesIn,
        messagesOut,
        contacts: contactsTotal,
        newContacts,
      },
      firstResponse: {
        avgSeconds: firstResponse?.[0]?.avg_seconds ?? null,
        medianSeconds: firstResponse?.[0]?.median_seconds ?? null,
        answered: firstResponse?.[0]?.answered ?? 0,
      },
      byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      byStage: byStage.map((r) => ({ stage: r.pipelineStage, count: r._count._all })),
      byAgent: byAgent.map((r) => ({ userId: r.sentByUserId, name: agentName(r.sentByUserId), messages: r._count._all })),
      daily,
      templateUsage: templateUsage.map((r) => ({ category: r.category ?? 'SIN_CATEGORIA', count: r._sum.quantity ?? 0 })),
      integrations,
    });
  })
);

export default router;
