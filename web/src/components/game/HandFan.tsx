import { RANK_CHARS, SUIT_SYMBOLS, cardRank, cardSuit } from '../../api';
import { PlayingCard } from './PlayingCard';

/**
 * Overlapping card fan. Every card that can't be tapped right now — because
 * it breaks follow-suit in the active fan, or because this fan isn't the one
 * to play from at all — is dimmed, so only genuinely playable cards read as
 * full color. Class names .handfan/.interactive/.cardbtn/.selected/.suitgap
 * are selected on by the e2e smoke test.
 */
export function HandFan({
  cards,
  legal,
  selected,
  onSelect,
  small = false,
}: {
  cards: number[];
  legal?: number[];
  selected?: number | null;
  onSelect?: (card: number) => void;
  small?: boolean;
}) {
  const interactive = Boolean(onSelect);
  return (
    <div className={`handfan${interactive ? ' interactive' : ''}${small ? ' handfan-sm' : ''}`}>
      {cards.map((c, i) => {
        const playable = interactive && (!legal || legal.includes(c));
        const newSuit = i > 0 && cardSuit(c) !== cardSuit(cards[i - 1]);
        return (
          <button
            key={c}
            type="button"
            className={`cardbtn${selected === c ? ' selected' : ''}${newSuit ? ' suitgap' : ''}`}
            disabled={!playable}
            onClick={playable ? () => onSelect!(c) : undefined}
            aria-label={`${RANK_CHARS[cardRank(c)]} of ${SUIT_SYMBOLS[cardSuit(c)]}`}
          >
            <PlayingCard card={c} small={small} dimmed={!playable} selected={selected === c} />
          </button>
        );
      })}
    </div>
  );
}
