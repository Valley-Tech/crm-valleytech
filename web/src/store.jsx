import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { get, post, tokenStore, onUnauthorized } from './api.js';
import { connectSocket, disconnectSocket } from './socket.js';

/* ------------------------------------------------------------------ toasts */
const ToastContext = createContext({ toast: () => {} });

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const toast = useCallback((text, { error = false, ms = 3500 } = {}) => {
    const id = Math.random().toString(36).slice(2);
    setItems((list) => [...list, { id, text, error }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), ms);
  }, []);
  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>{t.text}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext).toast;

/* ------------------------------------------------------------------- auth */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [config, setConfig] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await get('/api/config/public');
        if (alive) setConfig(cfg);
      } catch { /* la app funciona sin config pública */ }
      if (tokenStore.get()) {
        try {
          const me = await get('/api/auth/me');
          if (alive) { setUser(me); connectSocket(); }
        } catch { tokenStore.set(null); }
      }
      if (alive) setReady(true);
    })();
    const off = onUnauthorized(() => { setUser(null); disconnectSocket(); });
    return () => { alive = false; off(); };
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await post('/api/auth/login', { email, password });
    tokenStore.set(data.token);
    setUser(data.user);
    connectSocket();
    return data.user;
  }, []);

  const logout = useCallback(() => {
    tokenStore.set(null);
    disconnectSocket();
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, config, ready, login, logout }), [user, config, ready, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);

const ROLE_ORDER = { viewer: 0, agent: 1, admin: 2, owner: 3 };
export const hasRole = (user, minimum) => (ROLE_ORDER[user?.role] ?? -1) >= (ROLE_ORDER[minimum] ?? 99);
