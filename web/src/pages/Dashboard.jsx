import React, { useEffect, useMemo, useState } from 'react';
import { get } from '../api.js';
import { useToast } from '../store.jsx';
import { Badge, Chips, Loading, fmtDuration, CONV_STATUS } from '../components/ui.jsx';
import { GroupedBars, HBars } from '../components/Charts.jsx';

const RANGES = [{ value: 7, label: '7 días' }, { value: 30, label: '30 días' }, { value: 90, label: '90 días' }];

function KPI({ value, label, detail }) {
  return (
    <div className="kpi">
      <span className="v">{value}</span>
      <span className="k">{label}</span>
      {detail ? <span className="d">{detail}</span> : null}
    </div>
  );
}

export default function Dashboard() {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);

  useEffect(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    setData(null);
    get(`/api/metrics/overview?from=${from.toISOString()}&to=${to.toISOString()}`)
      .then(setData)
      .catch((e) => toast(e.message, { error: true }));
  }, [days, toast]);

  // Rellena los días sin mensajes para que la gráfica no salte.
  const daily = useMemo(() => {
    if (!data) return [];
    const map = new Map(data.daily.map((d) => [d.day, d]));
    const out = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      out.push(map.get(key) ?? { day: key, inbound: 0, outbound: 0 });
    }
    return out;
  }, [data, days]);

  if (!data) return <Loading />;
  const t = data.totals;

  return (
    <>
      <div className="page-head">
        <p>Actividad del periodo. Las conversaciones abiertas y pendientes son el estado actual, no el periodo.</p>
        <Chips value={days} onChange={setDays} items={RANGES} />
      </div>

      <div className="grid cols-4">
        <KPI value={t.conversations} label="Conversaciones nuevas" detail={`${t.open} abiertas · ${t.pending} pendientes ahora`} />
        <KPI value={t.messagesIn} label="Mensajes recibidos" detail={`${t.messagesOut} enviados`} />
        <KPI value={fmtDuration(data.firstResponse.medianSeconds)} label="Primera respuesta (mediana)" detail={`${data.firstResponse.answered} conversaciones respondidas por agentes`} />
        <KPI value={t.contacts} label="Contactos" detail={`${t.newContacts} nuevos en el periodo`} />
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Mensajes por día</h3>
          <div className="legend"><span><i style={{ background: 'var(--accent)' }} />recibidos</span><span><i style={{ background: 'var(--info)' }} />enviados</span></div>
        </div>
        <div className="card-body">
          <GroupedBars data={daily} keys={['inbound', 'outbound']} colors={['var(--accent)', 'var(--info)']} />
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head"><h3>Embudo</h3></div>
          <div className="card-body"><HBars rows={data.byStage.map((r) => ({ label: r.stage, count: r.count }))} /></div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Mensajes por agente</h3></div>
          <div className="card-body"><HBars rows={data.byAgent.map((r) => ({ label: r.name, count: r.messages }))} color="var(--info)" /></div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Estado de las conversaciones</h3></div>
          <div className="card-body"><HBars rows={data.byStatus.map((r) => ({ label: CONV_STATUS[r.status] ?? r.status, count: r.count }))} color="var(--warn)" /></div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Plantillas enviadas por categoría</h3><span className="tiny faint">Meta factura por esto</span></div>
          <div className="card-body"><HBars rows={data.templateUsage.map((r) => ({ label: r.category, count: r.count }))} color="var(--crit)" /></div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Salud de los números</h3></div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Número</th><th>Nombre</th><th>Calidad</th><th>Límite</th><th>Modo</th><th>Estado</th></tr></thead>
            <tbody>
              {data.integrations.map((i) => (
                <tr key={i.id}>
                  <td className="mono">{i.displayPhoneNumber}</td>
                  <td>{i.verifiedName ?? '—'}</td>
                  <td>{i.qualityRating ? <Badge tone={{ GREEN: 'ok', YELLOW: 'warn', RED: 'crit' }[i.qualityRating] ?? ''}>{i.qualityRating}</Badge> : '—'}</td>
                  <td className="mono small">{i.messagingTier ?? '—'}</td>
                  <td>{i.isCoexistence ? 'coexistencia' : 'Cloud API'}</td>
                  <td>{i.active ? <Badge tone="ok">activo</Badge> : <Badge tone="crit">inactivo</Badge>}</td>
                </tr>
              ))}
              {data.integrations.length === 0 ? <tr><td colSpan={6} className="muted">Sin números conectados</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
