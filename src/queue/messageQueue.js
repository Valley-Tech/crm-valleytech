import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import config from '../config/env.js';

export const connection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null, // requerido por BullMQ
});

export const messageQueue = new Queue('whatsapp-events', { connection });
