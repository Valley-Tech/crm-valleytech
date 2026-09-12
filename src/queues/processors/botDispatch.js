import logger from '../../lib/logger.js';
import { deliverToBot } from '../../services/botGateway.js';

export default async function processBotDispatch(job) {
  const { botId, payload } = job.data;

  try {
    return await deliverToBot({ botId, payload });
  } catch (err) {
    logger.warn(
      { botId, attempt: job.attemptsMade + 1, status: err.response?.status, err: err.message },
      'Falló el despacho al bot; se reintentará'
    );
    throw err;
  }
}
