import type { Mark } from '../../pages/activityFeed';

/**
 * The activity feed's hours rule: midnight to midnight, one ink mark per run,
 * height by boards played.
 *
 * This is what replaced heading the feed with three MORNING / AFTERNOON /
 * EVENING panels. The parts of the day are still the grouping underneath, but
 * here they're geography rather than compartments — two dashed hairs where the
 * cutoffs fall, and you read the shape of the day off the rule before reading
 * a single name.
 *
 * The `now` rule is the only red on the screen. The chart system allows
 * exactly one accent, and a hairline saying "everything to the right of this
 * hasn't happened yet" is a better use of it than a delta arrow, which already
 * carries a ▲/▼ glyph. It's drawn on today's strip only — on any other day
 * there is no now to mark.
 *
 * Same shop as Sparkline and StemChart: hand-rolled SVG, no chart library.
 * The graphic carries an aria-label summary and the rows below it carry the
 * real content, so nothing here is the only copy of anything.
 */
export function DayStrip({ marks, nowFraction, label }: { marks: Mark[]; nowFraction?: number; label: string }) {
  const W = 324;
  const BASELINE = 22;
  const MAX_MARK = 16;
  const x = (fraction: number) => fraction * W;

  return (
    <div className="daystrip">
      <svg width="100%" height="36" viewBox={`0 0 ${W} 36`} role="img" aria-label={label}>
        {/* where timeGreeting's cutoffs fall — noon and 6 PM. The 5 AM edge of
            morning is deliberately undrawn: three hairs is texture, two is a
            reading. */}
        <g stroke="var(--line)" strokeWidth="1" strokeDasharray="3 4">
          <line x1={x(12 / 24)} y1="4" x2={x(12 / 24)} y2={BASELINE} />
          <line x1={x(18 / 24)} y1="4" x2={x(18 / 24)} y2={BASELINE} />
        </g>

        {marks.map((m, i) => (
          <line
            key={i}
            x1={x(m.x)}
            y1={BASELINE}
            x2={x(m.x)}
            y2={BASELINE - m.height * MAX_MARK}
            stroke={m.kind === 'join' ? 'var(--line-dashed)' : 'var(--ink)'}
            strokeWidth="3"
          />
        ))}

        <line x1="0" y1={BASELINE} x2={W} y2={BASELINE} stroke="var(--ink)" strokeWidth="1" />
        <g stroke="var(--ink)" strokeWidth="1">
          <line x1="0.5" y1={BASELINE} x2="0.5" y2={BASELINE + 3} />
          <line x1={W - 0.5} y1={BASELINE} x2={W - 0.5} y2={BASELINE + 3} />
        </g>

        {nowFraction !== undefined ? (
          <g className="daystrip-now">
            <line x1={x(nowFraction)} y1="1" x2={x(nowFraction)} y2={BASELINE + 3} stroke="var(--accent)" strokeWidth="1" />
            <path
              d={`M${x(nowFraction) - 3} 1 L${x(nowFraction) + 3} 1 L${x(nowFraction)} 5 Z`}
              fill="var(--accent)"
            />
          </g>
        ) : null}

        <g className="daystrip-tick">
          <text x="0" y="34" textAnchor="start">
            12 AM
          </text>
          <text x={x(6 / 24)} y="34" textAnchor="middle">
            6 AM
          </text>
          <text x={x(12 / 24)} y="34" textAnchor="middle">
            NOON
          </text>
          <text x={x(18 / 24)} y="34" textAnchor="middle">
            6 PM
          </text>
          <text x={W} y="34" textAnchor="end">
            12 AM
          </text>
        </g>
      </svg>
    </div>
  );
}
