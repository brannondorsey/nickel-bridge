import { FlipDigits } from './FlipDigits';
import { useGlossary } from '../../glossary/GlossaryContext';

/**
 * The NICKEL RATING hero — flip-digit rating over a label line carrying an
 * optional signed delta.
 *
 * Lifted out of the Stats hero when Home's rating tile shipped, for the reason
 * that usually justifies a ds component and rarely holds: the two are meant to
 * be the SAME tile, not two tiles that resemble each other. What differs is
 * only what the delta measures — the last crossing (or the drift since it) on
 * Home, the month's swing on Stats — so that arrives as a number and a caption
 * rather than as a second copy of the markup.
 *
 * The delta renders whenever it is non-null, zero included — whether a zero is
 * worth saying is the caller's editorial call, not this component's, and the
 * two callers genuinely disagree. "+0 THIS MONTH" on a profile is a real
 * finding (you played a month and went nowhere); a bare arrow reading zero on
 * Home is the ordinary resting state of a screen you open every day, so Home
 * passes null there and the line falls back to reading NICKEL RATING.
 *
 * `deltaLabel` and `deltaCaption` are the two ways to name what the delta
 * measures, and they are for two different reading distances:
 *
 * - `deltaLabel` — Stats' "+34 THIS MONTH", tracked caps BESIDE the NICKEL
 *   RATING label. A figure you go to a profile to study, so it can afford to
 *   sit second on the line.
 * - `deltaCaption` — Home's "▲12 in the last crossing", the ladder's own
 *   movement glyph (Leaderboard.tsx's Movement, the one place this app already
 *   draws an arrow) plus a lowercase phrase, IN PLACE of the label. Home is
 *   glanced at rather than read: what moved and over what stretch is the whole
 *   message, and the word RATING is already implied by the four-digit ticker
 *   sitting directly above it. Sentence case rather than the label's caps for
 *   the reason the rehearsal ledger's rows are — it is a phrase about
 *   something that happened, not a label on a field.
 *
 * Passing neither leaves the bare glyph beside the label. Whichever shape is
 * showing, the delta is a door onto `explainTerm`: see its note below.
 */
export function RatingTile({
  elo,
  delta,
  deltaLabel,
  deltaCaption,
  size = 46,
  explainTerm,
}: {
  elo: number;
  /** signed points, or null for nothing to report — see the note above on zero */
  delta: number | null;
  /** names the period in tracked caps beside the label, e.g. 'THIS MONTH' */
  deltaLabel?: string;
  /**
   * names the period in lowercase after the ▲/▼ glyph, e.g. 'in the last
   * crossing' — and REPLACES the NICKEL RATING label while a delta is showing.
   * Ignored when `deltaLabel` is also given; the two are alternative shapes for
   * one line, not a pair.
   */
  deltaCaption?: string;
  size?: number;
  /**
   * Glossary slug opened by the delta, and by the NICKEL RATING label whenever
   * that label is on screen; omitted leaves them as plain text. The delta is
   * always a door on purpose — the arrow is the part that prompts "why did that
   * move without me?", and under `deltaCaption` it is the only thing on the
   * line to hang the answer off.
   */
  explainTerm?: string;
}) {
  const { openTerm } = useGlossary();
  const open = explainTerm ? () => openTerm(explainTerm) : null;
  const up = delta !== null && delta >= 0;
  // The caption stands in for the label rather than beside it — but only while
  // there is a delta to caption. With nothing to report the line still has to
  // say what the number above it is, so it falls back to NICKEL RATING.
  const captioned = Boolean(deltaCaption) && !deltaLabel && delta !== null;
  // Glyph + colour, never colour alone — Movement's rule on the ladder, and the
  // reason the arrow survives a flattened palette.
  const figure = delta === null ? null : deltaLabel ? `${up ? '+' : '−'}${Math.abs(delta)}` : `${up ? '▲' : '▼'}${Math.abs(delta)}`;
  // Two elements rather than one string in the captioned shape, because the
  // two halves are different kinds of thing and the design system already says
  // so: the figure is a tabular Besley numeral in its own --positive/--negative
  // ink, the caption an aside in italic Crimson at --muted. Which is also what
  // decides where the glossary's dotted rule goes — under the words that name
  // the period, not under the number, since the period is what the sheet
  // explains. See .rating-tile-delta-captioned in style.css.
  const body = captioned ? (
    <>
      <span className={`rating-tile-figure num ${up ? 'positive' : 'negative'}`}>{figure}</span>
      <span className="rating-tile-caption">{deltaCaption}</span>
    </>
  ) : deltaLabel ? (
    `${figure} ${deltaLabel}`
  ) : (
    figure
  );
  const deltaClass = `rating-tile-delta num ${up ? 'positive' : 'negative'}${captioned ? ' rating-tile-delta-captioned' : ''}`;
  // The ladder gets away with a bare ▲12 because its Movement is a
  // non-focusable <span>; here the same glyph becomes a control, and
  // "up-pointing triangle 4, button" is not a thing anyone can act on. Words,
  // the way RehearsalRail's stubs state their verdict — and only on the glyph
  // form, since the labelled one already reads as a sentence.
  const deltaAria =
    delta === null || deltaLabel
      ? undefined
      : `Rating ${up ? 'up' : 'down'} ${Math.abs(delta)} ${deltaCaption ?? 'since your last crossing'}`;
  return (
    <>
      <FlipDigits value={elo} size={size} />
      <div className="rating-tile-line">
        {captioned ? null : open ? (
          <button type="button" className="label-caps rating-tile-label rating-tile-explain" onClick={open}>
            NICKEL RATING
          </button>
        ) : (
          <span className="label-caps rating-tile-label">NICKEL RATING</span>
        )}
        {delta === null ? null : open ? (
          <button type="button" className={`${deltaClass} rating-tile-explain`} aria-label={deltaAria} onClick={open}>
            {body}
          </button>
        ) : (
          <span className={deltaClass}>{body}</span>
        )}
      </div>
    </>
  );
}
