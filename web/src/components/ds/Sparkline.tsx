import { useState } from 'react';

export interface SparkPoint {
  /** accessible name for the point's tap target, e.g. "Tournament #12" */
  label: string;
  /** short caption, e.g. "Jul 13" */
  caption?: string;
  value: number;
}

/**
 * Hand-rolled ink sparkline (replaces Recharts): polyline + endpoint dot,
 * optional dashed accent reference line and running-mean trend overlay.
 * Each point gets a full-height invisible <button> (≥44px wide at n≤7),
 * tap shows a detail line under the chart — works on touch and desktop.
 */
export function Sparkline({
  points,
  refValue,
  refLabel,
  trendWindow,
  format = (v) => String(v),
  leftCaption,
  rightCaption = 'latest',
}: {
  points: SparkPoint[];
  refValue?: number;
  refLabel?: string;
  trendWindow?: number;
  format?: (v: number) => string;
  leftCaption?: string;
  rightCaption?: string;
}) {
  const [selected, setSelected] = useState<number | null>(null);

  if (!points.length) return <div className="empty-note">No data yet — play a board.</div>;

  const W = 326;
  const values = points.map((p) => p.value);
  const all = refValue !== undefined ? [...values, refValue] : values;
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const x = (i: number) => (points.length === 1 ? W / 2 : 6 + (i * (W - 12)) / (points.length - 1));
  const y = (v: number) => 76 - ((v - min) / (max - min)) * 62;
  const line = points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');

  let trend = '';
  if (trendWindow && points.length > 1) {
    trend = points
      .map((_, i) => {
        const from = Math.max(0, i - trendWindow + 1);
        const window = values.slice(from, i + 1);
        return `${x(i)},${y(window.reduce((a, b) => a + b, 0) / window.length)}`;
      })
      .join(' ');
  }

  return (
    <div className="sparkline">
      <div className="sparkline-plot">
        <svg width="100%" height="86" viewBox={`0 0 ${W} 86`} preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1="14" x2={W} y2="14" stroke="var(--line)" strokeWidth="1" strokeDasharray="3 4" />
          {refValue !== undefined ? (
            <line className="sparkline-ref" x1="0" y1={y(refValue)} x2={W} y2={y(refValue)} stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="5 4" />
          ) : null}
          <line x1="0" y1="76" x2={W} y2="76" stroke="var(--line)" strokeWidth="1" />
          {trend ? <polyline points={trend} fill="none" stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="4 4" /> : null}
          <polyline points={line} fill="none" stroke="var(--ink)" strokeWidth="2.5" />
          {selected !== null ? <circle cx={x(selected)} cy={y(points[selected].value)} r="4.5" fill="var(--paper)" stroke="var(--ink)" strokeWidth="2" /> : null}
          <circle cx={x(points.length - 1)} cy={y(points[points.length - 1].value)} r="3.5" fill="var(--ink)" />
        </svg>
        <div className="sparkline-hits">
          {points.map((p, i) => (
            <button
              key={i}
              type="button"
              aria-label={p.label}
              onClick={() => setSelected(selected === i ? null : i)}
            />
          ))}
        </div>
      </div>
      <div className="sparkline-captions">
        <span>{leftCaption ?? points[0].caption ?? ''}</span>
        {refLabel ? <span className="sparkline-ref-label">- - {refLabel}</span> : null}
        <span>{rightCaption}</span>
      </div>
      {selected !== null ? (
        <div className="sparkline-detail num">
          {points[selected].label}
          {points[selected].caption ? ` · ${points[selected].caption}` : ''} · {format(points[selected].value)}
        </div>
      ) : null}
    </div>
  );
}
