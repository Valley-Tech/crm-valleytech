import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { get, post, del } from '../api.js';
import { useAuth, useToast, hasRole } from '../store.jsx';
import { Badge, Button, Confirm, Empty, Loading, Tabs, fmtDateTime, numberLabel } from '../components/ui.jsx';
import { TemplatePreview } from '../components/TemplatePicker.jsx';
import { TemplateBuilder } from '../components/TemplateBuilder.jsx';
import { I } from '../components/Icons.jsx';

const TONE = { approved: 'ok', pending: 'warn', rejected: 'crit', paused: 'warn', disabled: '' };
const LABEL = { approved: 'aprobada', pending: 'pendiente', rejected: 'rechazada', paused: 'pausada', disabled: 'deshabilitada' };

/**
 * Plantillas por chatbot. El backend ya devuelve solo las de los números que
 * el usuario administra; el selector de número acota más (o, para el
 * SuperAdmin, separa las de cada cliente).
 */
export default function Templates() {
  const { user } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [numbers, setNumbers] = useState([]);
  const [numberId, setNumberId] = useState('');
  const [status, setStatus] = useState('approved');
  const [selected, setSelected] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get('/api/inbox/channels').then((d) => {
      const list = d.items.filter((n) => n.active);
      setNumbers(list);
      // Con un solo número (caso típico de un dueño) se selecciona solo.
      if (list.length === 1) setNumberId(list[0].id);
    }).catch(() => {});
  }, []);

  const load = useCallback(() => {
    setItems(null);
    get(`/api/templates${numberId ? `?integrationId=${numberId}` : ''}`).then((d) => setItems(d.items)).catch((e) => toast(e.message, { error: true }));
  }, [toast, numberId]);
  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => (items ?? []).reduce((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {}), [items]);
  const filtered = (items ?? []).filter((t) => t.status === status);
  const current = numbers.find((n) => n.id === numberId) ?? null;

  async function sync() {
    setSyncing(true);
    try {
      const r = await post(`/api/templates/sync${numberId ? `?integrationId=${numberId}` : ''}`);
      toast(`${r.synced} plantillas sincronizadas desde Meta${r.removed ? ` · ${r.removed} eliminadas` : ''}`);
      load();
    } catch (err) { toast(err.message, { error: true }); } finally { setSyncing(false); }
  }

  return (
    <>
      <div className="page-head">
        <p>Crea aquí las plantillas de cada chatbot (Meta las revisa y aprueba, igual que en el WhatsApp Manager) o sincroniza las que ya existen. Las aprobadas se envían desde la bandeja y en campañas.</p>
        <div className="row wrap">
          {numbers.length > 1 ? (
            <select id="templates-number" className="select" value={numberId} onChange={(e) => setNumberId(e.target.value)} style={{ maxWidth: 320 }}>
              <option value="">Todos mis chatbots</option>
              {numbers.map((n) => <option key={n.id} value={n.id}>{numberLabel(n)}</option>)}
            </select>
          ) : current ? <Badge tone="accent">{numberLabel(current)}</Badge> : null}
          {hasRole(user, 'owner') ? <Button id="sync-templates" onClick={sync} loading={syncing}><I.refresh /> Sincronizar con Meta</Button> : null}
          {hasRole(user, 'owner') ? <Button id="new-template" variant="primary" onClick={() => setCreating(true)} disabled={numbers.length === 0}><I.plus /> Crear plantilla</Button> : null}
        </div>
      </div>

      <Tabs
        value={status}
        onChange={setStatus}
        items={['approved', 'pending', 'rejected', 'paused', 'disabled'].map((s) => ({ value: s, label: LABEL[s], count: counts[s] ?? 0 }))}
      />

      {items === null ? <Loading /> : null}
      {items !== null && items.length === 0 ? (
        <div className="card">
          <Empty title="Todavía no hay plantillas" icon={<I.templates />}>
            {numbers.length === 0 ? 'No tienes ningún número asignado; pide al SuperAdmin que te asigne tu chatbot.' : 'Pulsa "Sincronizar con Meta" para traer las de tu número.'}
          </Empty>
        </div>
      ) : null}

      {items && items.length > 0 ? (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(280px, 1fr) minmax(280px, 1fr)' }}>
          <div className="card table-wrap">
            <table className="table">
              <thead><tr><th>Nombre</th>{!numberId ? <th>Chatbot</th> : null}<th>Idioma</th><th>Categoría</th><th>Sincronizada</th></tr></thead>
              <tbody>
                {filtered.map((t) => (
                  <tr key={t.id} className="click" onClick={() => setSelected(t)} style={selected?.id === t.id ? { background: 'var(--sunk)' } : undefined}>
                    <td><span className="mono">{t.name}</span></td>
                    {!numberId ? <td className="small">{(t.numbers ?? []).map((n) => <div key={n.id}>{numberLabel(n)}</div>)}{!(t.numbers ?? []).length ? <span className="faint">WABA {t.wabaId}</span> : null}</td> : null}
                    <td>{t.language}</td>
                    <td><Badge tone="info">{t.category}</Badge></td>
                    <td className="small">{fmtDateTime(t.syncedAt)}</td>
                  </tr>
                ))}
                {filtered.length === 0 ? <tr><td colSpan={numberId ? 4 : 5} className="muted">Ninguna en este estado</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="card pad col" style={{ gap: 12 }}>
            {selected ? (
              <>
                <div className="row between">
                  <strong className="mono">{selected.name}</strong>
                  <Badge tone={TONE[selected.status]}>{LABEL[selected.status]}</Badge>
                </div>
                {(selected.numbers ?? []).length ? <div className="small muted">Número: {selected.numbers.map(numberLabel).join(' · ')}</div> : null}
                <TemplatePreview template={selected} values={{}} />
                <div className="small muted">
                  {(selected.components ?? []).map((c, i) => (
                    <div key={i}><strong>{c.type}</strong>{c.format ? ` · ${c.format}` : ''}{c.text ? `: ${c.text}` : ''}{c.buttons ? `: ${c.buttons.map((b) => b.text).join(' · ')}` : ''}</div>
                  ))}
                </div>
                <div className="row between">
                  <div className="tiny faint mono">id {selected.metaTemplateId ?? '—'}</div>
                  {hasRole(user, 'owner') ? <Button size="sm" variant="danger" onClick={() => setRemoving(selected)}><I.trash /> Eliminar</Button> : null}
                </div>
              </>
            ) : (
              <Empty title="Elige una plantilla">Verás la vista previa tal como la recibe el cliente.</Empty>
            )}
          </div>
        </div>
      ) : null}
      {creating ? (
        <TemplateBuilder
          numbers={numbers}
          initialNumberId={numberId}
          onClose={() => setCreating(false)}
          onDone={() => { setCreating(false); setStatus('pending'); load(); }}
        />
      ) : null}
      {removing ? (
        <Confirm
          title={`¿Eliminar la plantilla ${removing.name}?`}
          confirmLabel="Eliminar plantilla"
          danger
          busy={busy}
          onConfirm={async () => {
            setBusy(true);
            try {
              await del(`/api/templates/${removing.id}`);
              toast(`Plantilla ${removing.name} eliminada`);
              setRemoving(null);
              if (selected?.id === removing.id) setSelected(null);
              load();
            } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
          }}
          onClose={() => setRemoving(null)}
        >
          Se elimina en Meta y en el CRM. Las campañas que la usen ya no podrán enviarse, y Meta no deja reutilizar el nombre de una plantilla aprobada durante 30 días.
        </Confirm>
      ) : null}
    </>
  );
}
