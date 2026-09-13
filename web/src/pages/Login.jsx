import React, { useState } from 'react';
import { useAuth } from '../store.jsx';
import { Button, Field } from '../components/ui.jsx';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err.message || 'No se pudo iniciar sesión');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <div className="row" style={{ gap: 10 }}>
          <span className="avatar" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>V</span>
          <div>
            <h1 style={{ fontSize: '1.2rem' }}>CRM ValleyTech</h1>
            <p className="small muted">Bandeja unificada de WhatsApp</p>
          </div>
        </div>
        <Field label="Correo">
          <input id="login-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </Field>
        <Field label="Contraseña">
          <input id="login-password" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        {error ? <p className="small" style={{ color: 'var(--crit)' }}>{error}</p> : null}
        <Button id="login-submit" variant="primary" type="submit" loading={busy}>Entrar</Button>
      </form>
    </div>
  );
}
