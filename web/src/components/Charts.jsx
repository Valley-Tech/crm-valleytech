import React from 'react';

/**
 * Gráficas en SVG puro, sin librerías. Una sola escala, etiquetas que siempre
 * corresponden a valores reales, colores desde los tokens del tema.
 */

export function GroupedBars({ data, keys, colors, height = 200, labelEvery = null }) {
  const width = 720;
  const pad = { top: 12, right: 8, bottom: 26, left: 34 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...data.flatMap((d) => keys.map((k) => Number(d[k]) || 0)));
  const nice = niceMax(max);
  const groupW = innerW / Math.max(data.length, 1);
  const barW = Math.max(2, (groupW * 0.7) / keys.length);
  const every = labelEvery ?? Math.max(1, Math.ceil(data.length / 8));
  const ticks = [0, 0.5, 1].map((f) => Math.round(nice * f));

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Mensajes por día">
      {ticks.map((t) => {
        const y = pad.top + innerH - (t / nice) * innerH;
        return (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke="var(--rule)" strokeWidth="1" />
            <text x={pad.left - 6} y={y + 3} textAnchor="end">{t}</text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const gx = pad.left + i * groupW + (groupW - barW * keys.length) / 2;
        return (
          <g key={d.day ?? i}>
            {keys.map((k, j) => {
              const v = Number(d[k]) || 0;
              const h = (v / nice) * innerH;
              return <rect key={k} x={gx + j * barW} y={pad.top + innerH - h} width={barW - 1} height={h} fill={colors[j]} rx="1"><title>{`${d.day}: ${k} ${v}`}</title></rect>;
            })}
            {i % every === 0 ? (
              <text x={gx + (barW * keys.length) / 2} y={height - 8} textAnchor="middle">{String(d.day ?? '').slice(5)}</text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function HBars({ rows, valueKey = 'count', labelKey = 'label', color = 'var(--accent)' }) {
  const max = Math.max(1, ...rows.map((r) => Number(r[valueKey]) || 0));
  return (
    <div className="col" style={{ gap: 8 }}>
      {rows.map((r) => (
        <div key={r[labelKey]} className="bar-row">
          <span className="truncate">{r[labelKey]}</span>
          <div className="track"><div className="fill" style={{ width: `${((Number(r[valueKey]) || 0) / max) * 100}%`, background: color }} /></div>
          <span className="tabular" style={{ textAlign: 'right' }}>{r[valueKey]}</span>
        </div>
      ))}
      {rows.length === 0 ? <span className="small faint">Sin datos en este periodo</span> : null}
    </div>
  );
}

function niceMax(v) {
  if (v <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return n * p;
}
