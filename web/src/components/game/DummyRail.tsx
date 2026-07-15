import { RANK_CHARS, SUIT_SYMBOLS, cardRank, cardSuit, displaySort, suitClass } from '../../api';
import { HcpBadge } from '../ds/HcpBadge';

const SEAT_NAMES = ['NORTH', 'EAST', 'SOUTH', 'WEST'];

/**
 * Dummy on East or West is always the declaring side's exposed hand — never
 * played by the human, who only ever plays their own South cards or (as
 * declarer) a North/South dummy. Rendering it as a full-width fan at the top
 * of the screen, the same slot a partner's hand would occupy, reads as "my
 * teammate" when it's really an opponent. This rail puts it on its true
 * compass side instead, as a read-only vertical suit list — the same
 * one-row-per-suit convention DealDiagram already uses for the four-hand
 * result screen — so PlayPhase can narrow TrickArea to make room for it
 * rather than displacing the human's own fan.
 */
export function DummyRail({
  seat,
  cards,
  hcp,
  side,
}: {
  seat: number;
  cards: number[];
  hcp?: number;
  side: 'left' | 'right';
}) {
  const sorted = displaySort(cards);
  const suitRow = (suit: number) => sorted.filter((c) => cardSuit(c) === suit).map((c) => RANK_CHARS[cardRank(c)]);
  return (
    <div className={`dummy-rail dummy-rail-${side}`}>
      <div className="dummy-rail-head">
        <span className="dummy-rail-seat">{SEAT_NAMES[seat]}</span>
        <span className="dummy-rail-role">DUMMY</span>
        {typeof hcp === 'number' ? <HcpBadge hcp={hcp} /> : null}
      </div>
      {[0, 1, 2, 3].map((suit) => {
        const ranks = suitRow(suit);
        return (
          <div key={suit} className="dummy-rail-row num">
            <span className={suitClass(suit)}>{SUIT_SYMBOLS[suit]}</span>
            <span className="dummy-rail-ranks">{ranks.length ? ranks.join(' ') : '—'}</span>
          </div>
        );
      })}
    </div>
  );
}
