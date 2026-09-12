import { redis } from '../lib/redis.js';

export const REALTIME_CHANNEL = 'crm:realtime';

/**
 * Puente entre el worker y el proceso web.
 *
 * El worker no tiene servidor de WebSocket, así que publica el evento en Redis
 * y el proceso web (que sí tiene socket.io) lo reemite a las salas.
 */
export async function publishEvent(event) {
  await redis.publish(REALTIME_CHANNEL, JSON.stringify(event));
}

export const tenantRoom = (tenantId) => `tenant:${tenantId}`;
export const conversationRoom = (conversationId) => `conversation:${conversationId}`;
