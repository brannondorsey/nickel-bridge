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
 *
 * THE HOUR LABELS ARE HTML, NOT <text>, and that is load-bearing rather than
 * tidy. This strip is `width: 100%` over a viewBox 324 units wide, so at a
 * tablet's ~770px panel every user unit is scaled 2.4x — including type, which
 * put "12 AM / 6 AM / NOON / 6 PM" on screen at ~20px, twice the size of the
 * clock times in the rows underneath. Nothing inside a uniformly-scaled SVG
 * can opt out of that. So the plot scales on x alone (preserveAspectRatio
 * "none", with non-scaling-stroke keeping every rule at its drawn weight — a
 * stretched 1px line would otherwise thicken with the panel) and the labels
 * live outside it, positioned at their own fractions of the width, where a px
 * is a px at every viewport. The `now` flag is HTML for the same reason: it is
 * the one FILLED shape here, and a fill has no non-scaling-stroke to save it.
 */
export function DayStrip({ marks, nowFraction, label }: { marks: Mark[]; nowFraction?: number; label: string }) {
  const W = 324;
  const BASELINE = 22;
  const MAX_MARK = 16;
  const x = (fraction: number) => fraction * W;

  return (
    <div className="daystrip">
      <div className="daystrip-plot">
        <svg
          width="100%"
          height={BASELINE + 4}
          viewBox={`0 0 ${W} ${BASELINE + 4}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
        >
          {/* where timeGreeting's cutoffs fall — noon and 6 PM. The 5 AM edge of
              morning is deliberately undrawn: three hairs is texture, two is a
              reading. */}
          <g stroke="var(--line)" strokeWidth="1" strokeDasharray="3 4" vectorEffect="non-scaling-stroke">
            <line x1={x(12 / 24)} y1="4" x2={x(12 / 24)} y2={BASELINE} vectorEffect="non-scaling-stroke" />
            <line x1={x(18 / 24)} y1="4" x2={x(18 / 24)} y2={BASELINE} vectorEffect="non-scaling-stroke" />
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
              vectorEffect="non-scaling-stroke"
            />
          ))}

          <line
            x1="0"
            y1={BASELINE}
            x2={W}
            y2={BASELINE}
            stroke="var(--ink)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          <g stroke="var(--ink)" strokeWidth="1">
            <line x1="0.5" y1={BASELINE} x2="0.5" y2={BASELINE + 3} vectorEffect="non-scaling-stroke" />
            <line x1={W - 0.5} y1={BASELINE} x2={W - 0.5} y2={BASELINE + 3} vectorEffect="non-scaling-stroke" />
          </g>

          {nowFraction !== undefined ? (
            <line
              className="daystrip-now"
              x1={x(nowFraction)}
              y1="1"
              x2={x(nowFraction)}
              y2={BASELINE + 3}
              stroke="var(--accent)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {nowFraction !== undefined ? (
          <span className="daystrip-flag" style={{ left: `${nowFraction * 100}%` }} aria-hidden="true" />
        ) : null}
      </div>

      {/* aria-hidden to keep what the SVG's role="img" already did: the plot
          answers as one labelled graphic, and these are its axis marks. */}
      <div className="daystrip-tick" aria-hidden="true">
        <span style={{ left: '0%' }}>12 AM</span>
        <span style={{ left: '25%' }}>6 AM</span>
        <span style={{ left: '50%' }}>NOON</span>
        <span style={{ left: '75%' }}>6 PM</span>
        <span style={{ left: '100%' }}>12 AM</span>
      </div>
    </div>
  );
}
