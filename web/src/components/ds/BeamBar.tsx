/**
 * The beam: one measure, drawn as a balance that tips.
 *
 * A track with a centre line, a fill growing LEFT when the viewer leads and
 * RIGHT when the other player does, sized by the MARGIN rather than by either
 * figure — so reading a column of these top to bottom gives the shape of two
 * careers before a single number is read.
 *
 * The dashed marks either side of centre are the GATE: the margin below which
 * the difference sits inside its own measurement error. A fill that stops short
 * of its gate stays grey and names no winner, and it still shows the lean, so
 * "why isn't this one coloured" answers itself.
 *
 * DIRECTION IS THE ENCODING, COLOUR ONLY REINFORCES IT. --positive is
 * byte-identical to --suit-c and --negative to --suit-h, and the colourblind
 * suit palette rewrites the suit tokens while leaving these two alone — so a
 * player who turned that setting on because red and green are hard for them
 * would otherwise meet the one screen in the app that is entirely red and
 * green. Flatten every fill to a single ink and this component still reports
 * every verdict correctly, via side-of-centre and gate-crossing alone.
 *
 * aria-hidden throughout: the row that owns this bar prints the whole reading
 * as text, and announcing the geometry as well would say everything twice —
 * the same split Sparkline makes between aria-valuetext and its detail line.
 */

export type BeamVerdict = 'you' | 'them' | 'level' | 'aside';

export interface BeamBarProps {
  /** viewer's figure minus the other player's, in display units */
  margin: number;
  /** the threshold the margin must clear to be called, same units; null = unbounded, only ever on an `aside` row */
  gate: number | null;
  /** the margin at which the bar reaches the end of the track */
  fullTilt: number;
  verdict: BeamVerdict;
  /** printed inside the fill when there is room — the margin, not the score */
  label?: string;
}

/** Half the track is one side's territory, so a full tilt is 50% of the width. */
const HALF = 50;

export function BeamBar({ margin, gate, fullTilt, verdict, label }: BeamBarProps) {
  // A row whose gate will not fit on its own scale can never be called, so it
  // is drawn as an empty hatched track rather than a bar the reader would try
  // to interpret. The page states how many were set aside.
  if (verdict === 'aside') {
    return <span className="beam beam-aside" aria-hidden="true" />;
  }

  const fill = Math.min(HALF, (Math.abs(margin) / fullTilt) * HALF);
  // Clamped so a gate wider than the track still renders at the edge rather
  // than overflowing — the same treatment StemChart gives an out-of-range mean.
  // A null gate is unbounded, which only reaches here on an `aside` row (drawn
  // above). Pinned to the track edge rather than NaN if it ever does arrive.
  const gateAt = gate === null ? HALF : Math.min(HALF, (gate / fullTilt) * HALF);
  const ahead = margin > 0;

  return (
    <span className="beam" aria-hidden="true">
      <span className="beam-gate" style={{ left: `${HALF - gateAt}%` }} />
      <span className="beam-gate" style={{ left: `${HALF + gateAt}%` }} />
      <span
        className={`beam-fill${verdict === 'level' ? ' beam-fill-level' : ahead ? ' beam-fill-you' : ' beam-fill-them'}`}
        style={ahead ? { right: `${HALF}%`, width: `${fill}%` } : { left: `${HALF}%`, width: `${fill}%` }}
      >
        {label && fill > 12 ? <span className="beam-margin num">{label}</span> : null}
      </span>
      <span className="beam-centre" />
    </span>
  );
}
