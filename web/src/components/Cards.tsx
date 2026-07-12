import { RANK_CHARS, SUIT_SYMBOLS, cardRank, cardSuit, isRed } from '../api';

export function PlayingCard({ card, small }: { card: number; small?: boolean }) {
  return (
    <div className={`pcard${isRed(card) ? ' red' : ''}${small ? ' small' : ''}`}>
      <div className="rank">{RANK_CHARS[cardRank(card)]}</div>
      <div className="suit">{SUIT_SYMBOLS[cardSuit(card)]}</div>
    </div>
  );
}

export function HandFan({
  cards,
  legal,
  selected,
  onSelect,
  dummy,
}: {
  cards: number[];
  legal?: number[];
  selected?: number | null;
  onSelect?: (card: number) => void;
  dummy?: boolean;
}) {
  return (
    <div className={`handfan${dummy ? ' dummy' : ''}`}>
      {cards.map((c) => {
        const playable = onSelect && (!legal || legal.includes(c));
        return (
          <button
            key={c}
            className={`cardbtn${selected === c ? ' selected' : ''}`}
            disabled={!playable}
            onClick={playable ? () => onSelect!(c) : undefined}
            aria-label={`${RANK_CHARS[cardRank(c)]} of ${SUIT_SYMBOLS[cardSuit(c)]}`}
          >
            <PlayingCard card={c} small={dummy} />
          </button>
        );
      })}
    </div>
  );
}
