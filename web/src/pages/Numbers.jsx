import React, { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, patch, del } from '../api.js';
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
  const [diagnosing, setDiagnosing] = useState(null);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [webhook, setWebhook] = useState(null);

  const load = useCallback(() => {
    get('/api/integrations').then((d) => setItems(d.items)).catch((e) => toast(e.message, { error: true }));
  }, [toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    get('/api/integrations/webhook-status').then(setWebhook).catch(() => setWebhook(null));
  }, [items]);

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
              <tr><th>Número</th><th>Nombre verificado</th><th>Calidad</th><th>App de Meta</th><th>Modo</th><th>Último mensaje</th><th>Eco pausa bot</th><th>Activo</th><th></th></tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td style={{ whiteSpace: 'nowrap' }}><span className="mono">{i.displayPhoneNumber || i.phoneNumberId}</span><div className="tiny faint mono">{i.phoneNumberId}</div></td>
                  <td>{i.verifiedName || '—'}</td>
                  <td>{i.qualityRating ? <Badge tone={QUALITY[i.qualityRating] ?? ''}>{qualityLabel[i.qualityRating] ?? i.qualityRating}</Badge> : '—'}</td>
                  <td>
                    <span className="mono small">{i.metaAppId}</span>
                    <div className="tiny faint">{i.ownApp ? 'app del CRM' : 'app propia del cliente'}</div>
                  </td>
                  <td>
                    {i.isCoexistence ? <Badge tone="info">coexistencia</Badge> : <Badge>Cloud API</Badge>}
                    <div className="tiny faint">{i.onboardingMethod === 'embedded_signup' ? 'registro insertado' : 'manual'}</div>
                  </td>
                  <td className="small">
                    {i.lastInboundAt ? fmtDateTime(i.lastInboundAt) : <span className="faint">nunca</span>}
                    <div className="tiny faint">{i.lastWebhookAt ? `webhook ${fmtDateTime(i.lastWebhookAt)}` : 'sin webhooks'}</div>
                  </td>
                  <td><Switch on={i.echoPausesBot} onChange={(v) => update(i, { echoPausesBot: v })} /></td>
                  <td><Switch on={i.active} onChange={(v) => update(i, { active: v })} /></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <div className="row" style={{ gap: 6 }}>
                      <Button size="sm" onClick={() => setDiagnosing(i)}>Diagnosticar</Button>
                      <Button size="sm" onClick={() => setEditing(i)}>Credenciales</Button>
                      <Button size="sm" variant="danger" onClick={() => setDeleting(i)}>Eliminar</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card pad small muted">
        <strong>Eco pausa bot:</strong> en un número en coexistencia, cada mensaje enviado desde la app de WhatsApp Business (por una persona o por la IA de Meta) llega como <em>eco</em>. Si activas esta opción, ese eco pausa el chatbot conectado por el Bot Gateway en esa conversación. Déjala apagada si el número usa la IA de Meta.
      </div>

      {webhook ? <WebhookStatus webhook={webhook} items={items ?? []} /> : null}

      {connecting ? <ConnectModal config={config} onClose={() => setConnecting(false)} onDone={() => { setConnecting(false); load(); }} /> : null}
      {diagnosing ? <DiagnoseModal integration={diagnosing} onClose={() => setDiagnosing(null)} onChanged={load} /> : null}
      {editing ? <CredentialsModal integration={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} /> : null}
      {deleting ? <DeleteModal integration={deleting} siblings={(items ?? []).filter((x) => x.wabaId === deleting.wabaId && x.id !== deleting.id).length} onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); load(); }} /> : null}
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
      // El SDK de Meta exige un callback "function" normal: si se le pasa una
      // función async responde "Expression is of type asyncfunction, not function".
      const onLogin = (response) => {
        const code = response?.authResponse?.code;
        if (!code) { setState({ step: 'idle', detail: 'El diálogo se cerró sin completar el registro.' }); return; }
        setState({ step: 'exchange', detail: 'Conectando el número al CRM…' });
        const s = sessionRef.current;
        post('/api/integrations/meta/embedded-signup', {
          code,
          wabaId: s.waba_id,
          phoneNumberId: s.phone_number_id,
          coexistence: Boolean(s.coexistence || coexistence),
        })
          .then((integration) => { toast(`Número ${integration.displayPhoneNumber || ''} conectado`); onDone(); })
          .catch((err) => setState({ step: 'error', detail: err.message }));
      };
      FB.login(
        onLogin,
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
  const [form, setForm] = useState({ wabaId: '', phoneNumberId: '', accessToken: '', isCoexistence: false, metaAppId: '', metaAppSecret: '' });
  const [ownApp, setOwnApp] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = ownApp ? form : { ...form, metaAppId: '', metaAppSecret: '' };
      const integration = await post('/api/integrations/meta', payload);
      toast(`Número ${integration.displayPhoneNumber || ''} conectado${integration.subscribed === false ? ' (no se pudo suscribir el webhook: usa Diagnosticar)' : ''}`);
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
      <OwnAppFields ownApp={ownApp} setOwnApp={setOwnApp} form={form} set={set} />
      <div className="row end"><Button variant="primary" type="submit" loading={busy}>Conectar</Button></div>
    </form>
  );
}

/* ========================================================================== */
function OwnAppFields({ ownApp, setOwnApp, form, set }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      <label className="checkbox"><input type="checkbox" checked={ownApp} onChange={(e) => setOwnApp(e.target.checked)} /> <span className="small">El token se generó en <strong>otra app de Meta</strong> (no la del CRM)</span></label>
      {ownApp ? (
        <div className="callout info small">
          Meta calcula el <code>appsecret_proof</code> con el App Secret de la app dueña del token. Si el token es de otra app, el CRM necesita su App ID y App Secret (Meta for Developers → esa app → Configuración → Básica). Lo recomendable es generar el token desde la app del CRM y no marcar esta casilla.
        </div>
      ) : null}
      {ownApp ? (
        <div className="row" style={{ gap: 10 }}>
          <Field label="App ID de esa app"><input className="input mono" value={form.metaAppId} onChange={set('metaAppId')} required /></Field>
          <Field label="App Secret de esa app" hint="Se guarda cifrado."><input className="input mono" type="password" value={form.metaAppSecret} onChange={set('metaAppSecret')} required /></Field>
        </div>
      ) : null}
    </div>
  );
}

/* ========================================================================== */
function CredentialsModal({ integration, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ accessToken: '', metaAppId: integration.ownApp ? '' : integration.metaAppId, metaAppSecret: '' });
  const [ownApp, setOwnApp] = useState(!integration.ownApp);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = {
        ...(form.accessToken ? { accessToken: form.accessToken } : {}),
        metaAppId: ownApp ? form.metaAppId : '',
        metaAppSecret: ownApp ? form.metaAppSecret : '',
      };
      await post(`/api/integrations/${integration.id}/credentials`, payload);
      toast('Credenciales actualizadas');
      onDone();
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }

  return (
    <Modal title={`Credenciales de ${integration.displayPhoneNumber || integration.phoneNumberId}`} onClose={onClose}>
      <form className="col" style={{ gap: 12 }} onSubmit={submit}>
        <p className="small muted">Cambia el token de acceso (por ejemplo, por uno nuevo de usuario del sistema) o indica la app de Meta a la que pertenece. Se valida contra Meta antes de guardar.</p>
        <Field label="Nuevo token de acceso" hint="Déjalo vacío para conservar el actual."><input className="input mono" type="password" value={form.accessToken} onChange={set('accessToken')} /></Field>
        <OwnAppFields ownApp={ownApp} setOwnApp={setOwnApp} form={form} set={set} />
        <div className="row end"><Button variant="primary" type="submit" loading={busy}>Guardar</Button></div>
      </form>
    </Modal>
  );
}

/* ========================================================================== */
const LEVEL_TONE = { ok: 'ok', warn: 'warn', error: 'crit' };

function DiagnoseModal({ integration, onClose, onChanged }) {
  const toast = useToast();
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(() => {
    setReport(null); setError(null);
    get(`/api/integrations/${integration.id}/diagnose`).then(setReport).catch((e) => setError(e.message));
  }, [integration.id]);
  useEffect(() => { run(); }, [run]);

  async function subscribe() {
    setBusy(true);
    try {
      await post(`/api/integrations/${integration.id}/subscribe`, {});
      toast('App suscrita a los webhooks de la WABA');
      run(); onChanged();
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }

  return (
    <Modal title={`Diagnóstico de ${integration.displayPhoneNumber || integration.phoneNumberId}`} onClose={onClose} wide>
      {error ? <div className="callout crit small">{error}</div> : null}
      {!report && !error ? <Loading label="Consultando a Meta…" /> : null}
      {report ? (
        <div className="col" style={{ gap: 12 }}>
          <div className={`callout ${report.healthy ? '' : 'warn'} small`}>
            {report.healthy ? 'Todo en orden del lado de Meta. Si aun así no llegan mensajes, escribe al número desde un celular y vuelve a diagnosticar.' : 'Hay comprobaciones en rojo: corrige la primera y vuelve a diagnosticar.'}
            <div className="tiny faint" style={{ marginTop: 4 }}>App: <span className="mono">{report.appId}</span> · Webhook esperado: <span className="mono">{report.expectedWebhookUrl}</span></div>
          </div>
          <div className="col" style={{ gap: 8 }}>
            {report.checks.map((c) => (
              <div key={c.id} className="card pad" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 10, alignItems: 'start' }}>
                <Badge tone={LEVEL_TONE[c.level] ?? ''}>{c.level === 'ok' ? 'ok' : c.level === 'warn' ? 'aviso' : 'error'}</Badge>
                <div>
                  <div><strong>{c.title}</strong></div>
                  <div className="small muted" style={{ wordBreak: 'break-word' }}>{c.detail}</div>
                  {c.fix ? <div className="small" style={{ marginTop: 4 }}>→ {c.fix}</div> : null}
                  {c.id === 'subscribed' && !c.ok ? <div style={{ marginTop: 8 }}><Button size="sm" variant="primary" loading={busy} onClick={subscribe}>Suscribir webhooks</Button></div> : null}
                </div>
              </div>
            ))}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Button onClick={run}><I.refresh /> Volver a diagnosticar</Button>
            <Button loading={busy} onClick={subscribe}>Suscribir webhooks</Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

/* ========================================================================== */
function WebhookStatus({ webhook, items }) {
  const known = new Set(items.map((i) => i.phoneNumberId));
  const unknown = (webhook.unknownPhoneNumbers ?? []).filter((u) => !known.has(u.phoneNumberId));
  return (
    <div className="card pad small">
      <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div><strong>Webhook del CRM:</strong> <span className="mono">{webhook.webhookUrl}</span></div>
        <div><strong>App del CRM:</strong> <span className="mono">{webhook.appId}</span></div>
        <div><strong>Último webhook aceptado:</strong> {webhook.lastAccepted ? `${fmtDateTime(webhook.lastAccepted.at)} (${(webhook.lastAccepted.fields ?? []).join(', ') || 'sin campos'})` : <span className="faint">ninguno todavía</span>}</div>
        {webhook.lastRejected ? <div style={{ color: 'var(--crit)' }}><strong>Último rechazado por firma:</strong> {fmtDateTime(webhook.lastRejected.at)} — viene de una app cuyo App Secret el CRM no conoce.</div> : null}
      </div>
      {unknown.length ? (
        <div className="callout warn" style={{ marginTop: 10 }}>
          Meta está enviando eventos de números que <strong>no están conectados</strong> en este CRM: {unknown.map((u) => <span key={u.phoneNumberId} className="mono">{u.phoneNumberId} </span>)}. Conéctalos con "Conectar número" y sus mensajes empezarán a entrar.
        </div>
      ) : null}
    </div>
  );
}

/* ========================================================================== */
function DeleteModal({ integration, siblings, onClose, onDone }) {
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const [unsubscribe, setUnsubscribe] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = integration.displayPhoneNumber || integration.phoneNumberId;
  const expected = (integration.displayPhoneNumber || integration.phoneNumberId).replace(/\s+/g, '');
  const matches = typed.replace(/\s+/g, '') === expected;

  async function submit(e) {
    e.preventDefault();
    if (!matches) return;
    setBusy(true);
    try {
      const r = await del(`/api/integrations/${integration.id}?unsubscribe=${unsubscribe ? 'true' : 'false'}`);
      const parts = [`Número ${label} eliminado`];
      if (r.detached?.conversations) parts.push(`${r.detached.conversations} conversaciones conservadas sin número`);
      if (r.unsubscribed === false) parts.push('no se pudo retirar la suscripción en Meta');
      toast(parts.join(' · '));
      onDone();
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }

  return (
    <Modal title={`Eliminar ${label}`} onClose={onClose}>
      <form className="col" style={{ gap: 12 }} onSubmit={submit}>
        <div className="callout crit small">
          Esta acción no se puede deshacer. El token de acceso se borra del CRM y el número deja de recibir y enviar mensajes desde aquí.
        </div>
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Las conversaciones, mensajes y contactos <strong>se conservan</strong> como historial, pero no se podrá responder en ellas hasta volver a conectar el número.</li>
          <li>Los chatbots que atendían este número pasan a "Todos los números".</li>
          <li>Las campañas terminadas se conservan. Si hay campañas programadas o en curso, primero hay que pausarlas.</li>
          <li>Nada cambia en Meta: el número, la WABA y el token siguen existiendo allá.</li>
        </ul>
        {siblings === 0 ? (
          <label className="checkbox"><input type="checkbox" checked={unsubscribe} onChange={(e) => setUnsubscribe(e.target.checked)} /> <span className="small">Retirar también la suscripción de la app a esta WABA en Meta (deja de enviar webhooks al CRM). Márcalo solo si ningún otro sistema tuyo depende de ella.</span></label>
        ) : (
          <div className="small muted">Hay {siblings} número(s) más de la misma WABA conectados: la suscripción a los webhooks se mantiene.</div>
        )}
        <Field label={`Escribe ${label} para confirmar`}><input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></Field>
        <div className="row end" style={{ gap: 8 }}>
          <Button type="button" onClick={onClose}>Cancelar</Button>
          <Button variant="danger" type="submit" loading={busy} disabled={!matches}>Eliminar número</Button>
        </div>
      </form>
    </Modal>
  );
}
