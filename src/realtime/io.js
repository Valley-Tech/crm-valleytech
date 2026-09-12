import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import logger from '../lib/logger.js';
import { createRedis } from '../lib/redis.js';
import { REALTIME_CHANNEL, tenantRoom } from './events.js';

export function attachRealtime(httpServer) {
  const io = new Server(httpServer, { cors: { origin: true, credentials: true } });

  const pubClient = createRedis('socket-pub');
  const subClient = createRedis('socket-sub');
  io.adapter(createAdapter(pubClient, subClient));

  // Autenticación: el mismo JWT que usa la API REST.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Falta el token'));
    try {
      const claims = jwt.verify(token, env.JWT_SECRET);
      socket.data.auth = claims;
      next();
    } catch {
      next(new Error('Token inválido'));
    }
  });

  io.on('connection', (socket) => {
    const { tenantId, sub } = socket.data.auth;
    socket.join(tenantRoom(tenantId));
    logger.debug({ tenantId, userId: sub }, 'Agente conectado por WebSocket');

  });

  // Escucha lo que publica el worker y lo reparte a las salas.
  const bridge = createRedis('realtime-bridge');
  bridge.subscribe(REALTIME_CHANNEL, (err) => {
    if (err) logger.error({ err }, 'No se pudo suscribir al canal de tiempo real');
  });
  bridge.on('message', (channel, raw) => {
    if (channel !== REALTIME_CHANNEL) return;
    try {
      const event = JSON.parse(raw);
      // Un único emit a la sala del cliente. Si se emitiera también a una sala
      // por conversación, el agente que la tiene abierta está en ambas y
      // recibiría el mensaje dos veces (burbuja duplicada en la bandeja).
      io.to(tenantRoom(event.tenantId)).emit(event.type, event.payload);
    } catch (err) {
      logger.error({ err }, 'Evento de tiempo real ilegible');
    }
  });

  return io;
}
