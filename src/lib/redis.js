import IORedis from 'ioredis';
import env from '../config/env.js';
import logger from './logger.js';

/**
 * Fábrica de clientes de Redis.
 *
 * Cada cliente registra un manejador de 'error'. Sin él, Node trata el evento
 * 'error' de un EventEmitter como una excepción no capturada y tumba el
 * proceso: era una de las causas del bucle de reinicio en Railway.
 *
 * maxRetriesPerRequest: null lo exige BullMQ para sus bloqueos largos.
 */
export function createRedis(role = 'client') {
  const client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  client.on('error', (err) => logger.error({ err, role }, 'Error de conexión con Redis'));
  client.on('end', () => logger.warn({ role }, 'Conexión con Redis cerrada'));

  return client;
}

// Cliente de comandos compartido (colas, caché, publicación de eventos).
export const redis = createRedis('commands');

export default redis;
