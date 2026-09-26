import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import logger from '../lib/logger.js';
import prisma from '../lib/prisma.js';
import { createRedis } from '../lib/redis.js';
import { REALTIME_CHANNEL, tenantRoom } from './events.js';
import { loadAccess } from '../services/access.js';

/** Sala de un número concreto: la usan los usuarios que no lo ven todo. */
const integrationRoom = (tenantId, integrationId) => `tenant:${tenantId}:int:${integrationId}`;
/** Sala "comodín" de los usuarios con alcance limitado (eventos sin número: campañas, chats ya borrados). */
const scopedRoom = (tenantId) => `tenant:${tenantId}:scoped`;

// conversationId → integrationId (caché corta: evita una consulta por evento).
const convCache = new Map();
async function integrationOfConversation(conversationId) {
  const hit = convCache.get(conversationId);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const c = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { integrationId: true } }).catch(() => null);
  const value = c ? c.integrationId ?? null : undefined; // undefined = ya no existe
  convCache.set(conversationId, { at: Date.now(), value });
  if (convCache.size > 5000) convCache.clear();
  return value;
}

export function attachRealtime(httpServer) {
  const io = new Server(httpServer, { cors: { origin: true, credentials: true } });

  const pubClient = createRedis('socket-pub');
  const subClient = createRedis('socket-sub');
  io.adapter(createAdapter(pubClient, subClient));

  // Autenticación: el mismo JWT que usa la API REST, y el mismo alcance
  // (números asignados) que las rutas HTTP.
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Falta el token'));
    try {
      const claims = jwt.verify(token, env.JWT_SECRET);
      const access = await loadAccess(claims.sub);
      if (!access || access.tenantId !== claims.tenantId) return next(new Error('Usuario sin acceso'));
      socket.data.auth = { tenantId: access.tenantId, sub: access.userId, scope: access.scope };
      next();
    } catch {
      next(new Error('Token inválido'));
    }
  });

  io.on('connection', (socket) => {
    const { tenantId, sub, scope } = socket.data.auth;
    if (scope.all) {
      socket.join(tenantRoom(tenantId));
    } else {
      socket.join(scopedRoom(tenantId));
      for (const id of scope.integrationIds) socket.join(integrationRoom(tenantId, id));
    }
    logger.debug({ tenantId, userId: sub, all: scope.all }, 'Agente conectado por WebSocket');
  });

  // Escucha lo que publica el worker y lo reparte a las salas.
  const bridge = createRedis('realtime-bridge');
  bridge.subscribe(REALTIME_CHANNEL, (err) => {
    if (err) logger.error({ err }, 'No se pudo suscribir al canal de tiempo real');
  });
  bridge.on('message', async (channel, raw) => {
    if (channel !== REALTIME_CHANNEL) return;
    try {
      const event = JSON.parse(raw);
      // Un único emit por sala. Si se emitiera también a una sala por
      // conversación, el agente que la tiene abierta la recibiría dos veces.
      io.to(tenantRoom(event.tenantId)).emit(event.type, event.payload);

      // Usuarios con alcance limitado: solo si el evento es de uno de sus números.
      let integrationId = event.integrationId;
      if (integrationId === undefined && event.conversationId) integrationId = await integrationOfConversation(event.conversationId);
      if (integrationId) io.to(integrationRoom(event.tenantId, integrationId)).emit(event.type, event.payload);
      else if (integrationId === undefined) io.to(scopedRoom(event.tenantId)).emit(event.type, event.payload); // sin número conocido (campañas, chat ya borrado)
      // integrationId === null (chat sin número): solo lo ve el superadmin.
    } catch (err) {
      logger.error({ err }, 'Evento de tiempo real ilegible');
    }
  });

  return io;
}
