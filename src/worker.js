import { Worker } from 'bullmq';
import env from './config/env.js';
import logger from './lib/logger.js';
import prisma from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { QUEUE, closeQueues } from './queues/index.js';
import processInboundEvent from './queues/processors/inboundEvent.js';
import processOutboundMessage from './queues/processors/outboundMessage.js';
import processMediaDownload from './queues/processors/mediaDownload.js';
import processBotDispatch from './queues/processors/botDispatch.js';
import processCampaignSend from './queues/processors/campaignSend.js';
import processKnowledgeIndex from './queues/processors/knowledgeIndex.js';

/**
 * Proceso worker, separado del web a propósito.
 *
 * Antes el worker se importaba dentro de server.js: una ejecución lenta del bot
 * bloqueaba el bucle de eventos y retrasaba el 200 que Meta espera, con lo que
 * Meta reintentaba y duplicaba eventos.
 */

const workers = [
  new Worker(QUEUE.inbound, processInboundEvent, { connection: redis, concurrency: 10 }),
  new Worker(QUEUE.outbound, processOutboundMessage, {
    connection: redis,
    concurrency: 5,
    limiter: { max: env.OUTBOUND_RATE_PER_SECOND, duration: 1000 },
  }),
  new Worker(QUEUE.media, processMediaDownload, { connection: redis, concurrency: 3 }),
  new Worker(QUEUE.botDispatch, processBotDispatch, { connection: redis, concurrency: 10 }),
  // Una campaña a la vez por worker: el ritmo real lo marca la cola de salida.
  new Worker(QUEUE.campaign, processCampaignSend, { connection: redis, concurrency: 1 }),
  // Indexar en Gemini puede tardar minutos (rastreo de sitios): de dos en dos.
  new Worker(QUEUE.knowledge, processKnowledgeIndex, { connection: redis, concurrency: 2, lockDuration: 15 * 60 * 1000 }),
];

for (const worker of workers) {
  worker.on('completed', (job) => logger.debug({ queue: worker.name, jobId: job.id }, 'Trabajo completado'));
  worker.on('failed', (job, err) =>
    logger.error(
      { queue: worker.name, jobId: job?.id, attempts: job?.attemptsMade, err: err?.message },
      'Trabajo fallido'
    )
  );
  worker.on('error', (err) => logger.error({ queue: worker.name, err }, 'Error del worker'));
}

logger.info({ queues: workers.map((w) => w.name) }, 'Worker del CRM en marcha');

async function shutdown(signal) {
  logger.info({ signal }, 'Cerrando worker');
  try {
    await Promise.all(workers.map((worker) => worker.close()));
    await closeQueues();
    await prisma.$disconnect();
    await redis.quit();
  } catch (err) {
    logger.error({ err }, 'Error al cerrar el worker');
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'Promesa rechazada sin manejar'));
