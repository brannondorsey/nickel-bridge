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
 * finding (you played a month and went nowhere); a bare arrow reading zero on
 * Home is the ordinary resting state of a screen you open every day, so Home
 * passes null there and the line simply reads NICKEL RATING.
 *
 * `deltaLabel` decides its SHAPE, and the two shapes are for two different
 * reading distances. With a label the delta spells the period out — Stats'
 * "+34 THIS MONTH", a figure you go to a profile to study. Without one it
 * collapses to the ladder's own movement glyph, ▲12 / ▼12 (Leaderboard.tsx's
 * Movement, the one place this app already draws an arrow), because Home is
 * glanced at rather than read and naming the period there cost two lines to
 * say something the glossary sheet says better. Which is why the label is
 * ALSO the explanation's door: see `explainTerm`.
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
  /** names the period, e.g. 'THIS MONTH'; omit for the bare ▲12 / ▼12 glyph */
  deltaLabel?: string;
  size?: number;
  /**
   * Glossary slug opened by BOTH the NICKEL RATING label and the delta beside
   * it; omitted leaves the pair as plain text. Both are doors on purpose —
   * the arrow is the part that prompts "why did that move without me?", so
   * making only the label answerable would put the explanation next to the
   * one figure that doesn't need it.
   */
  explainTerm?: string;
}) {
  const { openTerm } = useGlossary();
  const open = explainTerm ? () => openTerm(explainTerm) : null;
  // Glyph + colour, never colour alone — Movement's rule on the ladder, and the
  // reason the arrow survives a flattened palette.
  const deltaText =
    delta === null
      ? null
      : deltaLabel
        ? `${delta >= 0 ? '+' : '−'}${Math.abs(delta)} ${deltaLabel}`
        : `${delta >= 0 ? '▲' : '▼'}${Math.abs(delta)}`;
  const deltaClass = `rating-tile-delta num ${delta !== null && delta >= 0 ? 'positive' : 'negative'}`;
  // The ladder gets away with a bare ▲12 because its Movement is a
  // non-focusable <span>; here the same glyph becomes a control, and
  // "up-pointing triangle 4, button" is not a thing anyone can act on. Words,
  // the way RehearsalRail's stubs state their verdict — and only on the arrow
  // form, since the labelled one already reads as a sentence.
  const deltaAria =
    delta === null || deltaLabel ? undefined : `Rating ${delta >= 0 ? 'up' : 'down'} ${Math.abs(delta)} since your last crossing`;
  return (
    <>
      <FlipDigits value={elo} size={size} />
      <div className="rating-tile-line">
        {open ? (
          <button type="button" className="label-caps rating-tile-label rating-tile-explain" onClick={open}>
            NICKEL RATING
          </button>
        ) : (
          <span className="label-caps rating-tile-label">NICKEL RATING</span>
        )}
        {deltaText === null ? null : open ? (
          <button type="button" className={`${deltaClass} rating-tile-explain`} aria-label={deltaAria} onClick={open}>
            {deltaText}
          </button>
        ) : (
          <span className={deltaClass}>{deltaText}</span>
        )}
      </div>
    </>
  );
}
