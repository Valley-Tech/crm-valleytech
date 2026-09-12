import { Queue } from 'bullmq';
import { redis } from '../lib/redis.js';

export const QUEUE = {
  inbound: 'crm.inbound',
  outbound: 'crm.outbound',
  media: 'crm.media',
  botDispatch: 'crm.bot-dispatch',
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

export const allQueues = [inboundQueue, outboundQueue, mediaQueue, botDispatchQueue];

export async function closeQueues() {
  await Promise.all(allQueues.map((queue) => queue.close()));
}
