import { RANK_CHARS, SUIT_SYMBOLS, cardRank, cardSuit } from '../../api';
import { fanMarginLeft } from './fanLayout';
import { capturePlayOrigin } from './playAnim';
import { PlayingCard } from './PlayingCard';

/**
 * Overlapping card fan, optically spaced: each card's margin (computed in
 * fanLayout.ts) exposes the previous card's printed value plus a fixed gap,
 * so the visible values sit at an even rhythm regardless of how wide each
 * glyph is. Passing `legal` opts the fan into dimming: cards not
 * in it read as muted (whether because they break follow-suit, or because
 * this fan isn't the one to play from right now). Omitting `legal` — as the
 * read-only hand list on the bidding screen does — renders every card full
 * color; there's no notion of a legal card outside of play. Class names
 * .handfan/.interactive/.cardbtn/.selected/.suitgap are selected on by the
 * e2e smoke test (.suitgap no longer spaces differently, but still marks the
 * first card of each suit).
 */
export function HandFan({
  cards,
  legal,
  selected,
  onSelect,
  small = false,
  hint = null,
}: {
  cards: number[];
  legal?: number[];
  selected?: number | null;
  onSelect?: (card: number) => void;
  small?: boolean;
  /** first-crossing tour: pulse this card as the tollkeeper's suggestion */
  hint?: number | null;
}) {
  const interactive = Boolean(onSelect);
  return (
    <div className={`handfan${interactive ? ' interactive' : ''}${small ? ' handfan-sm' : ''}`}>
      {cards.map((c, i) => {
        const playable = interactive && (!legal || legal.includes(c));
        const dimmed = legal !== undefined && !legal.includes(c);
        const newSuit = i > 0 && cardSuit(c) !== cardSuit(cards[i - 1]);
        return (
          <button
            key={c}
            type="button"
            data-card={c}
            className={`cardbtn${selected === c ? ' selected' : ''}${newSuit ? ' suitgap' : ''}${hint === c && selected !== c ? ' card-hint' : ''}`}
            style={i > 0 ? { marginLeft: fanMarginLeft(cards[i - 1], small) } : undefined}
            disabled={!playable}
            onClick={
              playable
                ? (e) => {
                    // second tap plays: remember where the card left the fan
                    // so TrickArea can glide it into the trick slot from here
                    if (selected === c) capturePlayOrigin(c, e.currentTarget.getBoundingClientRect());
                    onSelect!(c);
                  }
                : undefined
            }
            aria-label={`${RANK_CHARS[cardRank(c)]} of ${SUIT_SYMBOLS[cardSuit(c)]}`}
          >
            <PlayingCard card={c} small={small} dimmed={dimmed} selected={selected === c} />
          </button>
        );
      })}
    </div>
  );
}
