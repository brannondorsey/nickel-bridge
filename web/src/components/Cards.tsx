import { RANK_CHARS, SUIT_SYMBOLS, cardRank, cardSuit, suitClass } from '../api';

export function PlayingCard({ card, small }: { card: number; small?: boolean }) {
  const rank = RANK_CHARS[cardRank(card)];
  return (
    <div className={`pcard ${suitClass(cardSuit(card))}${small ? ' small' : ''}`}>
      <div className={`rank${rank === '10' ? ' ten' : ''}`}>{rank}</div>
      <div className="suit">{SUIT_SYMBOLS[cardSuit(card)]}</div>
    </div>
  );
}

export function HandFan({
  cards,
  legal,
  selected,
  onSelect,
}: {
  cards: number[];
  legal?: number[];
  selected?: number | null;
  onSelect?: (card: number) => void;
}) {
  // Only an interactive fan (a card is being chosen from it right now) dims
  // its unplayable cards — an idle fan stays fully legible.
  const interactive = Boolean(onSelect);
  return (
    <div className={`handfan${interactive ? ' interactive' : ''}`}>
      {cards.map((c, i) => {
        const playable = interactive && (!legal || legal.includes(c));
        const newSuit = i > 0 && cardSuit(c) !== cardSuit(cards[i - 1]);
        return (
          <button
            key={c}
            className={`cardbtn${selected === c ? ' selected' : ''}${newSuit ? ' suitgap' : ''}`}
            disabled={!playable}
            onClick={playable ? () => onSelect!(c) : undefined}
            aria-label={`${RANK_CHARS[cardRank(c)]} of ${SUIT_SYMBOLS[cardSuit(c)]}`}
          >
            <PlayingCard card={c} />
          </button>
        );
      })}
    </div>
  );
}
