import { Queue } from 'bullmq';
import { redis } from '../lib/redis.js';

export const QUEUE = {
  inbound: 'crm.inbound',
  outbound: 'crm.outbound',
  media: 'crm.media',
  botDispatch: 'crm.bot-dispatch',
  campaign: 'crm.campaign',
  knowledge: 'crm.knowledge',
  maintenance: 'crm.maintenance',
};

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 1000, age: 60 * 60 * 24 },
  // Los fallidos se conservan: son la cola de fallidos que hay que revisar.
  removeOnFail: { count: 5000 },
};

export const inboundQueue = new Queue(QUEUE.inbound, { connection: redis, defaultJobOptions });
export const outboundQueue = new Queue(QUEUE.outbound, { connection: redis, defaultJobOptions });
export const mediaQueue = new Queue(QUEUE.media, { connection: redis, defaultJobOptions });
export const botDispatchQueue = new Queue(QUEUE.botDispatch, {
  connection: redis,
  defaultJobOptions: { ...defaultJobOptions, attempts: 4 },
});

export const campaignQueue = new Queue(QUEUE.campaign, {
  connection: redis,
  defaultJobOptions: { ...defaultJobOptions, attempts: 3 },
});

// Indexación de conocimiento (archivos, sitios web) en Gemini: lenta, pocos reintentos.
export const knowledgeQueue = new Queue(QUEUE.knowledge, {
  connection: redis,
  defaultJobOptions: { ...defaultJobOptions, attempts: 2, backoff: { type: 'fixed', delay: 15000 } },
});

// Tareas periódicas (reactivar bots tras la inactividad). Sin reintentos: se repiten solas.
export const maintenanceQueue = new Queue(QUEUE.maintenance, {
  connection: redis,
  defaultJobOptions: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } },
});

/** Programa las tareas repetitivas (idempotente: BullMQ no duplica un mismo jobId). */
export async function scheduleMaintenance() {
  await maintenanceQueue.add('resume-idle-bots', {}, { repeat: { every: 60 * 1000 }, jobId: 'resume-idle-bots' });
}

export const allQueues = [inboundQueue, outboundQueue, mediaQueue, botDispatchQueue, campaignQueue, knowledgeQueue, maintenanceQueue];

export async function closeQueues() {
  await Promise.all(allQueues.map((queue) => queue.close()));
}
