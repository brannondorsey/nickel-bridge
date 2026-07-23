export interface StemPoint {
  /** short axis tick, e.g. "−2" or "MADE" */
  tick: string;
  pct: number;
  count: number;
}

/**
 * Hand-rolled horizontal stem plot: one square-cornered ink bar per point,
 * rising off a shared baseline, height ∝ percentage — a histogram folded
 * onto a single axis instead of stacked rows. A dashed accent line marks a
 * continuous reference position along that same axis (e.g. an average that
 * isn't a whole point), matching Sparkline's dashed-reference-line idiom.
 * The SVG is decorative (percentages are already printed on it); an
 * `.sr-only` list carries the same data for screen readers, same purpose as
 * DayGrid's per-cell aria-label.
 */
export function StemChart({
  points,
  avgIndex,
  avgLabel,
  leftCaption,
  rightCaption,
  format = (v) => `${v}%`,
}: {
  points: StemPoint[];
  /** continuous position along the point axis (0..points.length-1) for the dashed marker */
  avgIndex: number;
  avgLabel: string;
  leftCaption: string;
  rightCaption: string;
  format?: (pct: number) => string;
}) {
  const W = 326;
  const H = 116;
  const BASELINE = 82;
  const MAX_BAR = 42;
  const BAR_W = 20;
  // half the bar width plus a hair of breathing room, so the end bars'
  // corners never clip past the viewBox edge (bit us in testing: a 6px
  // margin against a 20px-wide bar clips ~4px of ink off both ends).
  const MARGIN = BAR_W / 2 + 6;
  // the average label lives in its own band well above the tallest possible
  // bar's own value label (baseline − MAX_BAR − 7 at most), so the two can
  // never collide vertically regardless of where the marker clamps to
  // horizontally — seen for real with an extreme average pinned to an edge
  // bucket that also happened to be the tallest bar.
  const AVG_LABEL_Y = 12;

  const n = points.length;
  const x = (i: number) => (n === 1 ? W / 2 : MARGIN + (i * (W - 2 * MARGIN)) / (n - 1));
  const maxPct = Math.max(1, ...points.map((p) => p.pct));
  const clampedAvgIndex = Math.max(0, Math.min(n - 1, avgIndex));
  const xAvg = x(clampedAvgIndex);
  // flip the label to the marker's inboard side once it's clamped near an
  // edge, so it reads away from the axis end instead of running off it.
  const avgOnRight = clampedAvgIndex > (n - 1) / 2;

  if (n === 0) return null;

  return (
    <div className="stemchart">
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1={BASELINE} x2={W} y2={BASELINE} stroke="var(--line)" strokeWidth="1" />
        <line x1={xAvg} y1="8" x2={xAvg} y2={BASELINE} stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="4 3" />
        <text
          x={avgOnRight ? xAvg - 5 : xAvg + 5}
          y={AVG_LABEL_Y}
          textAnchor={avgOnRight ? 'end' : 'start'}
          className="stemchart-avg"
        >
          {avgLabel}
        </text>
        {points.map((p, i) => {
          const barH = (p.pct / maxPct) * MAX_BAR;
          const cx = x(i);
          return (
            <g key={i}>
              <rect x={cx - BAR_W / 2} y={BASELINE - barH} width={BAR_W} height={barH} fill="var(--ink)" />
              <text x={cx} y={BASELINE - barH - 7} className="stemchart-val">
                {format(p.pct)}
              </text>
              <text x={cx} y={BASELINE + 15} className="stemchart-tick">
                {p.tick}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="stemchart-captions">
        <span>{leftCaption}</span>
        <span>{rightCaption}</span>
      </div>
      <ul className="sr-only">
        {points.map((p, i) => (
          <li key={i}>
            {p.tick}: {format(p.pct)} — {p.count} board{p.count === 1 ? '' : 's'}
          </li>
        ))}
      </ul>
    </div>
  );
}
