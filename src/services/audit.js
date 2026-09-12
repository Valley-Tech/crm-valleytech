import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

/** Registra una acción. Nunca debe tumbar la operación que la originó. */
export async function recordAudit({ tenantId, actorType = 'user', actorUserId, action, entity, entityId, metadata }) {
  try {
    await prisma.auditLog.create({
      data: { tenantId, actorType, actorUserId, action, entity, entityId, metadata },
    });
  } catch (err) {
    logger.error({ err, action, entity }, 'No se pudo escribir el log de auditoría');
  }
}
