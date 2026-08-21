import { RANK_CHARS, SUIT_SYMBOLS, cardRank, cardSuit, suitClass } from '../../api';

/**
 * Corner-indexed playing card in the suit triad. Fans overlap via negative
 * margins in CSS. `dimmed` mutes unplayable cards inside an interactive fan;
 * `placeholder` renders the dashed empty slot used in the trick area.
 *
 * `foil` marks this card as a trump for the Foil Trumps treatment. It only
 * puts an attribute on the face: the shine itself is painted by one canvas
 * over the whole container (FoilLayer/foil.ts), which finds its cards by
 * exactly this attribute. Marking here rather than at the container keeps the
 * two halves from having to agree twice about which suit is trumps.
 */
export function PlayingCard({
  card,
  small = false,
  dimmed = false,
  selected = false,
  placeholder = false,
  foil = false,
}: {
  card?: number;
  small?: boolean;
  dimmed?: boolean;
  selected?: boolean;
  placeholder?: boolean;
  /** paint the Foil Trumps holographic plate over this card */
  foil?: boolean;
}) {
  if (placeholder || card === undefined) {
    return <div className={`pcard-placeholder${small ? ' small' : ''}`} />;
  }
  const rank = RANK_CHARS[cardRank(card)];
  const cls = [
    'pcard',
    suitClass(cardSuit(card)),
    small ? 'small' : '',
    dimmed ? 'dimmed' : '',
    selected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} data-foil={foil ? '' : undefined}>
      <div className={`rank${rank === '10' ? ' ten' : ''}`}>{rank}</div>
      <div className="suit">{SUIT_SYMBOLS[cardSuit(card)]}</div>
    </div>
  );
}
