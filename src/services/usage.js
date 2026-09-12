import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

/**
 * Consumo por cliente. Es la base de la facturación: Meta cobra por mensaje de
 * plantilla, así que sin esto el SaaS no sabe cuánto cuesta cada cliente.
 */
export async function recordUsage({ tenantId, conversationId, messageId, kind, category, quantity = 1 }) {
  try {
    await prisma.usageEvent.create({
      data: { tenantId, conversationId, messageId, kind, category, quantity },
    });
  } catch (err) {
    logger.error({ err, kind, tenantId }, 'No se pudo registrar el consumo');
  }
}

/** Resumen para el panel: totales por tipo en un rango de fechas. */
export async function usageSummary({ tenantId, from, to }) {
  const rows = await prisma.usageEvent.groupBy({
    by: ['kind', 'category'],
    where: { tenantId, occurredAt: { gte: from, lte: to } },
    _sum: { quantity: true },
  });

  return rows.map((row) => ({
    kind: row.kind,
    category: row.category,
    quantity: row._sum.quantity ?? 0,
  }));
}
