import { tokenStore } from './api.js';

/**
 * Conexión de tiempo real. El cliente de socket.io lo sirve el backend en
 * /socket.io/socket.io.js (ver index.html), así que aquí solo se usa window.io.
 */
let socket = null;

export function connectSocket() {
  if (socket) return socket;
  if (typeof window.io !== 'function') {
    console.warn('[realtime] socket.io no está cargado; la bandeja se actualizará sin tiempo real');
    return null;
  }
  socket = window.io({ auth: { token: tokenStore.get() }, transports: ['websocket', 'polling'] });
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

export function getSocket() {
  return socket;
}
