import { useMemo, useRef, useState } from 'react';

export interface SparkPoint {
  /** accessible name for the point, e.g. "Tournament #12" */
  label: string;
  /** short caption, e.g. "Jul 13" */
  caption?: string;
  value: number;
}

/** Plot geometry, in SVG user units. The plot stretches to its container on x
 *  alone (`preserveAspectRatio="none"`) at a fixed 86px height, so these are a
 *  design width rather than pixels — 326 is the same figure DayGrid and
 *  StemChart are drawn against, and roughly the phone's own plot width.
 *
 *  Stretching is what a time series wants at width: a wider panel spreads the
 *  points out rather than making the chart taller. Uniform scaling was tried
 *  and turned a 1440px profile's three sparklines into 163px-tall slabs (311px
 *  at 2560), strokes and all. What a non-uniform viewBox gets wrong is the
 *  MARKS, so none of them is left to it: every stroke is
 *  `vector-effect: non-scaling-stroke` (style.css), and the dots are not
 *  circles — a `<circle>` stretched 2× is an ellipse — but zero-length lines
 *  with round caps, which a non-scaling stroke draws as a true circle of
 *  exactly its stroke width at any scale. */
const W = 326;
const TOP = 14;
const BASE = 76;

/**
 * Hand-rolled ink sparkline (replaces Recharts): polyline + endpoint dot,
 * optional dashed accent reference line and running-mean trend overlay.
 *
 * Selection is a **scrubber**, not one tap target per point. The whole plot is a
 * single `role="slider"`: dragging (or arrowing) resolves the nearest point by x,
 * so the reader aims at a position on the line rather than at a mark. The older
 * model gave every point its own full-height invisible button, which put the
 * usable lookback at roughly 25 points — 326/n is a 13px target there and an
 * untappable 3px at 100 — and put one tab stop per point per chart in the
 * keyboard order. Resolving by proximity has no such ceiling, which is what lets
 * Player.tsx offer a lookback window at all.
 *
 * The slider role carries the whole reading for assistive tech: `aria-valuetext`
 * announces the selected point's name, date and value on every step, so the
 * visual detail line below the plot is `aria-hidden` rather than announced twice.
 *
 * Perf note: the polyline strings are memoized on `points`, so scrubbing
 * re-renders only the crosshair and the readout. That matters at long lookbacks
 * — a 1,000-point `points` attribute is ~12KB of string that must not be rebuilt
 * on every pointermove. Nothing here decimates the line itself; if a series ever
 * exceeds the ~326 available pixel columns, an LTTB pass over the drawn vertices
 * (drawing only — never what the scrubber resolves against) is the lever.
 */
export function Sparkline({
  points,
  label,
  refValue,
  refLabel,
  trendWindow,
  format = (v) => String(v),
  leftCaption,
  rightCaption = 'latest',
}: {
  points: SparkPoint[];
  /** accessible name for the scrubber, e.g. "Matchpoints by tournament" */
  label: string;
  refValue?: number;
  refLabel?: string;
  trendWindow?: number;
  format?: (v: number) => string;
  leftCaption?: string;
  rightCaption?: string;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  const geom = useMemo(() => {
    if (!points.length) return null;
    const values = points.map((p) => p.value);
    const all = refValue !== undefined ? [...values, refValue] : values;
    let min = Math.min(...all);
    let max = Math.max(...all);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const x = (i: number) => (points.length === 1 ? W / 2 : 6 + (i * (W - 12)) / (points.length - 1));
    const y = (v: number) => BASE - ((v - min) / (max - min)) * (BASE - TOP);
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
    return { x, y, line, trend };
  }, [points, refValue, trendWindow]);

  if (!geom) return <div className="empty-note">No data yet — play a board.</div>;

  const { x, y, line, trend } = geom;
  const n = points.length;
  // A selection outlives a change of `points`: the LOOKBACK window swaps a
  // SHORTER series into this same instance without remounting, so an index
  // picked against the longer one can now be past the end. Clamp once here and
  // read only `sel`/`active` below — indexing on raw `selected` throws on an
  // undefined point, and with no error boundary in the app that blanks the whole
  // Stats page. Clamping rather than clearing keeps the common case honest: the
  // latest point stays the latest point across a resize.
  const sel = selected === null ? null : Math.min(selected, n - 1);
  // What the slider reports when nothing has been picked yet: the latest point,
  // which is also what the endpoint dot already marks.
  const active = sel ?? n - 1;
  const shown = points[active];

  /** Nearest point to a client x — the reader aims at a position, not a mark. */
  const pickAt = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    const xUser = ((clientX - rect.left) / rect.width) * W;
    const i = n === 1 ? 0 : Math.round(((xUser - 6) / (W - 12)) * (n - 1));
    setSelected(Math.max(0, Math.min(n - 1, i)));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(n - 1, active + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, active - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') {
      setSelected(null);
      return;
    }
    if (next !== null) {
      e.preventDefault();
      setSelected(next);
    }
  };

  return (
    <div className="sparkline">
      <div
        ref={plotRef}
        className="sparkline-plot"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={active}
        aria-valuetext={`${shown.label}${shown.caption ? `, ${shown.caption}` : ''}, ${format(shown.value)}`}
        onKeyDown={onKeyDown}
        onFocus={() => setSelected((s) => s ?? n - 1)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pickAt(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons || e.pointerType === 'mouse') pickAt(e.clientX);
        }}
        onPointerLeave={() => {
          if (document.activeElement !== plotRef.current) setSelected(null);
        }}
      >
        <svg width="100%" height="86" viewBox={`0 0 ${W} 86`} preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1={TOP} x2={W} y2={TOP} stroke="var(--line)" strokeWidth="1" strokeDasharray="3 4" />
          {refValue !== undefined ? (
            <line className="sparkline-ref" x1="0" y1={y(refValue)} x2={W} y2={y(refValue)} stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="5 4" />
          ) : null}
          <line x1="0" y1={BASE} x2={W} y2={BASE} stroke="var(--line)" strokeWidth="1" />
          {trend ? <polyline points={trend} fill="none" stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="4 4" /> : null}
          <polyline points={line} fill="none" stroke="var(--ink)" strokeWidth="2.5" />
          {sel !== null ? (
            <>
              <line x1={x(sel)} y1={TOP - 6} x2={x(sel)} y2={BASE} stroke="var(--ink)" strokeWidth="1" strokeDasharray="2 3" />
              {/* a r=4.5 ring with a 2px stroke: 11px of ink, a 7px paper hole */}
              <Dot cx={x(sel)} cy={y(points[sel].value)} d={11} color="var(--ink)" />
              <Dot cx={x(sel)} cy={y(points[sel].value)} d={7} color="var(--paper)" />
            </>
          ) : null}
          <Dot cx={x(n - 1)} cy={y(points[n - 1].value)} d={7} color="var(--ink)" />
        </svg>
      </div>
      <div className="sparkline-captions">
        <span>{leftCaption ?? points[0].caption ?? ''}</span>
        {refLabel ? <span className="sparkline-ref-label">- - {refLabel}</span> : null}
        <span>{rightCaption}</span>
      </div>
      {sel !== null ? (
        <div className="sparkline-detail num" aria-hidden="true">
          {shown.label}
          {shown.caption ? ` · ${shown.caption}` : ''} · {format(shown.value)}
        </div>
      ) : null}
    </div>
  );
}

/** A round dot `d` px across that stays round under the plot's x-only stretch
 *  — see the geometry note at the top of this file. */
function Dot({ cx, cy, d, color }: { cx: number; cy: number; d: number; color: string }) {
  return <line x1={cx} y1={cy} x2={cx} y2={cy} stroke={color} strokeWidth={d} strokeLinecap="round" />;
}
