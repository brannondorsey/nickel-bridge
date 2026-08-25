import { FlipDigits } from './FlipDigits';
import { useGlossary } from '../../glossary/GlossaryContext';

/**
 * The NICKEL RATING hero — flip-digit rating over a label line carrying an
 * optional signed delta.
 *
 * Lifted out of the Stats hero when Home's rating tile shipped, for the reason
 * that usually justifies a ds component and rarely holds: the two are meant to
 * be the SAME tile, not two tiles that resemble each other. What differs is
 * only what the delta measures — drift since your last crossing on Home, the
 * month's swing on Stats — so that arrives as a number and a caption rather
 * than as a second copy of the markup.
 *
 * The delta renders whenever it is non-null, zero included — whether a zero is
 * worth saying is the caller's editorial call, not this component's, and the
 * two callers genuinely disagree. "+0 THIS MONTH" on a profile is a real
 * finding (you played a month and went nowhere); "+0 SINCE YOUR LAST CROSSING"
 * on Home is the ordinary resting state of a screen you open every day, so
 * Home passes null there and the line simply reads NICKEL RATING.
 */
export function RatingTile({
  elo,
  delta,
  deltaLabel,
  size = 46,
  explainTerm,
}: {
  elo: number;
  /** signed points, or null for nothing to report — see the note above on zero */
  delta: number | null;
  /** what the delta is measured over, e.g. 'SINCE YOUR LAST CROSSING' */
  deltaLabel: string;
  size?: number;
  /** glossary slug to open from the NICKEL RATING label; omitted leaves it plain text */
  explainTerm?: string;
}) {
  const { openTerm } = useGlossary();
  return (
    <>
      <FlipDigits value={elo} size={size} />
      <div className="rating-tile-line">
        {explainTerm ? (
          <button
            type="button"
            className="label-caps rating-tile-label rating-tile-explain"
            onClick={() => openTerm(explainTerm)}
          >
            NICKEL RATING
          </button>
        ) : (
          <span className="label-caps rating-tile-label">NICKEL RATING</span>
        )}
        {delta !== null ? (
          <span className={`rating-tile-delta num ${delta >= 0 ? 'positive' : 'negative'}`}>
            {delta >= 0 ? '+' : '−'}
            {Math.abs(delta)} {deltaLabel}
          </span>
        ) : null}
      </div>
    </>
  );
}
