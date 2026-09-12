import http from 'node:http';
import env from './config/env.js';
import logger from './lib/logger.js';
import prisma from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { createApp } from './http/app.js';
import { attachRealtime } from './realtime/io.js';
import { closeQueues } from './queues/index.js';

const app = createApp();
const server = http.createServer(app);

attachRealtime(server);

server.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV, webhook: `${env.PUBLIC_URL}/webhooks/meta` },
    'CRM ValleyTech escuchando'
  );
});

async function shutdown(signal) {
  logger.info({ signal }, 'Cerrando el servidor web');
  server.close();
  try {
    await closeQueues();
    await prisma.$disconnect();
    await redis.quit();
  } catch (err) {
    logger.error({ err }, 'Error durante el cierre');
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'Promesa rechazada sin manejar'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Excepción no capturada');
  process.exit(1);
});
