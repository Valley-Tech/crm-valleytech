/**
 * Cliente HTTP mínimo. Guarda el token en localStorage y lo manda en cada
 * petición. Un 401 limpia la sesión y avisa a la app para volver al login.
 */
const TOKEN_KEY = 'crm_token';

export const tokenStore = {
  get: () => {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set: (token) => {
    try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch { /* sin storage */ }
  },
};

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.message || `Error ${status}`);
    this.status = status;
    this.code = payload?.code;
    this.details = payload?.details;
  }
}

const listeners = new Set();
export const onUnauthorized = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const token = tokenStore.get();
  const init = {
    method,
    headers: {
      ...(raw ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
  };

  const res = await fetch(path, init);

  if (res.status === 401) {
    tokenStore.set(null);
    listeners.forEach((fn) => fn());
    throw new ApiError(401, { message: 'Sesión expirada' });
  }
  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error ?? { message: 'Error' });
  return data;
}

export const get = (path) => api(path);
export const post = (path, body) => api(path, { method: 'POST', body });
export const patch = (path, body) => api(path, { method: 'PATCH', body });
export const del = (path) => api(path, { method: 'DELETE' });

/** URL de un archivo guardado por el CRM (las etiquetas <img> no pueden mandar cabeceras). */
export const mediaUrl = (messageId) => `/api/media/${messageId}?token=${encodeURIComponent(tokenStore.get() ?? '')}`;
