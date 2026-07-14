import { RANK_CHARS, SUIT_SYMBOLS, cardRank, cardSuit, suitClass } from '../../api';

/**
 * Corner-indexed playing card in the suit triad. Fans overlap via negative
 * margins in CSS. `dimmed` mutes unplayable cards inside an interactive fan;
 * `placeholder` renders the dashed empty slot used in the trick area.
 */
export function PlayingCard({
  card,
  small = false,
  dimmed = false,
  selected = false,
  placeholder = false,
}: {
  card?: number;
  small?: boolean;
  dimmed?: boolean;
  selected?: boolean;
  placeholder?: boolean;
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
    <div className={cls}>
      <div className={`rank${rank === '10' ? ' ten' : ''}`}>{rank}</div>
      <div className="suit">{SUIT_SYMBOLS[cardSuit(card)]}</div>
    </div>
  );
}
