import logger from '../../lib/logger.js';
import { resumeIdleBots } from '../../services/conversations.js';

/**
 * Tareas periódicas del worker (cada minuto).
 *  · resume-idle-bots: reactiva el bot en los chats donde un humano intervino y
 *    ya pasaron los minutos de inactividad configurados en el número.
 */
export default async function processMaintenance(job) {
  if (job.name === 'resume-idle-bots') {
    const resumed = await resumeIdleBots();
    if (resumed) logger.info({ resumed }, 'Bots reactivados por inactividad');
    return { resumed };
  }
  return null;
}
