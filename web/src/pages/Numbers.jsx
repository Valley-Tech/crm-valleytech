import React, { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, patch } from '../api.js';
import { useAuth, useToast } from '../store.jsx';
import { Badge, Button, Empty, Field, Loading, Modal, Switch, Tabs, fmtDateTime } from '../components/ui.jsx';
import { I } from '../components/Icons.jsx';

/* ---------------------------------------------------------------- SDK de Meta */
let sdkPromise = null;
function loadFacebookSdk(appId, version) {
  if (window.FB) return Promise.resolve(window.FB);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB);
    };
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/es_LA/sdk.js';
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => { sdkPromise = null; reject(new Error('No se pudo cargar el SDK de Meta. Revisa bloqueadores de anuncios.')); };
    document.body.appendChild(script);
  });
  return sdkPromise;
}

const QUALITY = { GREEN: 'ok', YELLOW: 'warn', RED: 'crit' };
const qualityLabel = { GREEN: 'buena', YELLOW: 'media', RED: 'baja' };

/* ========================================================================== */
export default function Numbers() {
  const { config } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [connecting, setConnecting] = useState(false);

  const load = useCallback(() => {
    get('/api/integrations').then((d) => setItems(d.items)).catch((e) => toast(e.message, { error: true }));
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  async function update(integration, data) {
    try {
      const updated = await patch(`/api/integrations/${integration.id}`, data);
      setItems((list) => list.map((i) => (i.id === updated.id ? updated : i)));
    } catch (err) { toast(err.message, { error: true }); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <p>Cada número conectado es una cuenta de WhatsApp Business de un cliente. Los mensajes de todos llegan a la misma bandeja, separados por cliente.</p>
        </div>
        <Button id="connect-number" variant="primary" onClick={() => setConnecting(true)}><I.plus /> Conectar número</Button>
      </div>

      {!config?.embeddedSignupConfigId ? (
        <div className="callout warn">
          <strong>Registro insertado sin configurar.</strong> Falta <code>META_EMBEDDED_SIGNUP_CONFIG_ID</code> en el servidor. Mientras tanto puedes conectar números de forma manual.
        </div>
      ) : null}

      {items === null ? <Loading /> : items.length === 0 ? (
        <div className="card"><Empty title="Ningún número conectado" icon={<I.numbers />}>Conecta el primero con el botón de arriba.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr><th>Número</th><th>Nombre verificado</th><th>Calidad</th><th>Límite</th><th>Modo</th><th>Eco pausa bot</th><th>Activo</th><th>Conectado</th></tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td><span className="mono">{i.displayPhoneNumber || i.phoneNumberId}</span><div className="tiny faint mono">{i.phoneNumberId}</div></td>
                  <td>{i.verifiedName || '—'}</td>
                  <td>{i.qualityRating ? <Badge tone={QUALITY[i.qualityRating] ?? ''}>{qualityLabel[i.qualityRating] ?? i.qualityRating}</Badge> : '—'}</td>
                  <td className="mono small">{i.messagingTier ?? '—'}</td>
                  <td>
                    {i.isCoexistence ? <Badge tone="info">coexistencia</Badge> : <Badge>Cloud API</Badge>}
                    <div className="tiny faint">{i.onboardingMethod === 'embedded_signup' ? 'registro insertado' : 'manual'}</div>
                  </td>
                  <td><Switch on={i.echoPausesBot} onChange={(v) => update(i, { echoPausesBot: v })} /></td>
                  <td><Switch on={i.active} onChange={(v) => update(i, { active: v })} /></td>
                  <td className="small">{fmtDateTime(i.connectedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card pad small muted">
        <strong>Eco pausa bot:</strong> en un número en coexistencia, cada mensaje enviado desde la app de WhatsApp Business (por una persona o por la IA de Meta) llega como <em>eco</em>. Si activas esta opción, ese eco pausa el chatbot conectado por el Bot Gateway en esa conversación. Déjala apagada si el número usa la IA de Meta.
      </div>

      {connecting ? <ConnectModal config={config} onClose={() => setConnecting(false)} onDone={() => { setConnecting(false); load(); }} /> : null}
    </>
  );
}

/* ========================================================================== */
function ConnectModal({ config, onClose, onDone }) {
  const toast = useToast();
  const [tab, setTab] = useState(config?.embeddedSignupConfigId ? 'signup' : 'manual');
  const [state, setState] = useState({ step: 'idle', detail: '' });
  const sessionRef = useRef({});

  // Meta manda los ids de la sesión por postMessage mientras el diálogo avanza.
  useEffect(() => {
    const onMessage = (event) => {
      if (typeof event.origin !== 'string' || !event.origin.endsWith('facebook.com')) return;
      try {
        const data = JSON.parse(event.data);
        if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
        if (data.event === 'FINISH' || data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
          sessionRef.current = { ...data.data, coexistence: data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' };
          setState({ step: 'session', detail: `Número ${data.data?.phone_number_id ?? ''} listo, esperando el código…` });
        } else if (data.event === 'CANCEL') {
          setState({ step: 'idle', detail: `Cancelado en el paso ${data.data?.current_step ?? '?'}` });
        } else if (data.event === 'ERROR') {
          setState({ step: 'error', detail: data.data?.error_message ?? 'Error en el diálogo de Meta' });
        }
      } catch { /* mensajes de otros orígenes */ }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  async function startSignup(coexistence) {
    setState({ step: 'loading', detail: 'Cargando el SDK de Meta…' });
    try {
      const FB = await loadFacebookSdk(config.metaAppId, config.metaGraphVersion);
      setState({ step: 'dialog', detail: 'Completa el registro en la ventana de Meta…' });
      FB.login(
        async (response) => {
          const code = response?.authResponse?.code;
          if (!code) { setState({ step: 'idle', detail: 'El diálogo se cerró sin completar el registro.' }); return; }
          setState({ step: 'exchange', detail: 'Conectando el número al CRM…' });
          try {
            const s = sessionRef.current;
            const integration = await post('/api/integrations/meta/embedded-signup', {
              code,
              wabaId: s.waba_id,
              phoneNumberId: s.phone_number_id,
              coexistence: Boolean(s.coexistence || coexistence),
            });
            toast(`Número ${integration.displayPhoneNumber || ''} conectado`);
            onDone();
          } catch (err) {
            setState({ step: 'error', detail: err.message });
          }
        },
        {
          config_id: config.embeddedSignupConfigId,
          response_type: 'code',
          override_default_response_type: true,
          extras: {
            setup: {},
            featureType: coexistence ? 'whatsapp_business_app_onboarding' : '',
            sessionInfoVersion: '3',
          },
        }
      );
    } catch (err) {
      setState({ step: 'error', detail: err.message });
    }
  }

  return (
    <Modal title="Conectar un número de WhatsApp" onClose={onClose} wide>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'signup', label: 'Cuenta nueva o propia' },
          { value: 'coexistence', label: 'Cuenta que ya usa la app' },
          { value: 'manual', label: 'Manual' },
        ]}
      />

      {tab === 'signup' || tab === 'coexistence' ? (
        <div className="col" style={{ gap: 14 }}>
          {tab === 'signup' ? (
            <p className="small muted">El cliente inicia sesión con Facebook, elige o crea su cuenta de WhatsApp Business y su número. Al terminar, el CRM recibe el acceso y suscribe los webhooks automáticamente.</p>
          ) : (
            <p className="small muted">Para clientes que ya atienden desde la app de WhatsApp Business en el celular y quieren seguir usándola. El número queda en <strong>coexistencia</strong>: la app y el CRM al mismo tiempo. El CRM importa el historial reciente y los contactos.</p>
          )}
          {tab === 'coexistence' ? (
            <div className="callout info small">
              Requisitos de Meta: app de WhatsApp Business actualizada en el celular del cliente, y el CRM debe ser Tech Provider aprobado. Límite fijo de 20 mensajes por segundo; sin listas de difusión ni grupos.
            </div>
          ) : null}
          {!config?.embeddedSignupConfigId ? (
            <div className="callout warn small">Falta configurar el registro insertado en el servidor (<code>META_EMBEDDED_SIGNUP_CONFIG_ID</code>).</div>
          ) : null}
          <div className="row" style={{ gap: 12 }}>
            <Button id="start-signup" variant="primary" disabled={!config?.embeddedSignupConfigId || ['loading', 'dialog', 'exchange'].includes(state.step)} onClick={() => startSignup(tab === 'coexistence')}>
              Iniciar con Facebook
            </Button>
            {['loading', 'dialog', 'exchange', 'session'].includes(state.step) ? <span className="spinner" /> : null}
            <span className={`small ${state.step === 'error' ? '' : 'muted'}`} style={state.step === 'error' ? { color: 'var(--crit)' } : undefined}>{state.detail}</span>
          </div>
        </div>
      ) : (
        <ManualForm onDone={onDone} />
      )}
    </Modal>
  );
}

/* ========================================================================== */
function ManualForm({ onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ wabaId: '', phoneNumberId: '', accessToken: '', isCoexistence: false });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const integration = await post('/api/integrations/meta', form);
      toast(`Número ${integration.displayPhoneNumber || ''} conectado`);
      onDone();
    } catch (err) {
      toast(err.message, { error: true });
    } finally { setBusy(false); }
  }

  return (
    <form className="col" style={{ gap: 12 }} onSubmit={submit}>
      <p className="small muted">Para números que administras tú directamente en Meta for Developers. Los IDs están en <em>WhatsApp → Configuración de la API</em>; el token debe ser de un <strong>usuario del sistema</strong> con caducidad "nunca".</p>
      <Field label="WhatsApp Business Account ID (WABA)"><input className="input mono" value={form.wabaId} onChange={set('wabaId')} required /></Field>
      <Field label="Phone Number ID"><input className="input mono" value={form.phoneNumberId} onChange={set('phoneNumberId')} required /></Field>
      <Field label="Token de acceso" hint="Se valida contra Meta y se guarda cifrado. No se vuelve a mostrar."><input className="input mono" type="password" value={form.accessToken} onChange={set('accessToken')} required /></Field>
      <label className="checkbox"><input type="checkbox" checked={form.isCoexistence} onChange={set('isCoexistence')} /> <span className="small">Este número también se usa desde la app de WhatsApp Business (coexistencia)</span></label>
      <div className="row end"><Button variant="primary" type="submit" loading={busy}>Conectar</Button></div>
    </form>
  );
}
