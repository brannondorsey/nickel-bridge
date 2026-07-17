import { cardRank, cardSuit } from '../../api';

/**
 * Optical fan spacing: instead of overlapping every card by the same fraction
 * of its width, each card yields exactly the width of its *printed value* plus
 * a fixed gap, so the rhythm the eye reads — value, gap, value, gap — is even.
 * A wide "10" gets more room than a slim "J"; suit breaks get no extra space
 * (the color change already carries the grouping).
 *
 * The widths below are the rendered widths of each corner index at the
 * reference card size (--card-h: 66px → rank at 15px, suit glyph at 14px),
 * Besley 800, measured in Chromium ("10" includes its -0.09em tracking, see
 * .pcard .rank.ten). Suit glyphs aren't in Besley's latin subset, so like the
 * cards themselves they render in the platform serif — these are Chromium/
 * DejaVu numbers, and a ±1px platform difference only nudges the gap, never
 * hides a value. Everything scales linearly with --card-h, so margins are
 * emitted as calc() of the token and track the fit-derived card size in
 * style.css (whose canonical-hand constant derives from this same table).
 */

/* indexed like RANK_CHARS: 2 3 4 5 6 7 8 9 10 J Q K A */
const RANK_W = [10.13, 8.92, 9.38, 9.22, 9.52, 8.72, 9.22, 9.52, 15.88, 10.23, 13.33, 14.17, 13.89];
/* indexed like SUIT_SYMBOLS: ♠ ♥ ♦ ♣ */
const SUIT_W = [7.44, 8.31, 7.16, 9.19];

/* reference-size card geometry (see .pcard in style.css) */
const CARD_W = 46; // --card-w at --card-h: 66px
const PAD_L = 5; // corner-index left padding (shared by the small variant)
export const FAN_GAP = 6; // px between printed values — fixed, not token-scaled

/** Width of a card's printed corner value (rank stacked over suit glyph). */
const valueWidth = (card: number) => Math.max(RANK_W[cardRank(card)], SUIT_W[cardSuit(card)]);

/**
 * margin-left for the card that follows `prev` in a fan: pull it back over
 * prev's card body, leaving prev's value plus FAN_GAP exposed. The small
 * (0.8×) variant scales the card body and value fonts but shares .pcard's
 * corner padding, hence pad stays unscaled.
 */
export function fanMarginLeft(prev: number, small = false): string {
  const s = small ? 0.8 : 1;
  const scaled = (-CARD_W * s + PAD_L + valueWidth(prev) * s) / 66;
  return `calc(var(--card-h) * ${scaled.toFixed(4)} + ${FAN_GAP}px)`;
}
