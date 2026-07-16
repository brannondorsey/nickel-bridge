import { RANK_CHARS, SEAT_SHORT, SUIT_SYMBOLS, cardRank, cardSuit, displaySort, suitClass } from '../../api';

const SEAT_NAMES = ['NORTH', 'EAST', 'SOUTH', 'WEST'];

function HandCell({ seat, cards, mine, dummy }: { seat: number; cards: number[]; mine: boolean; dummy: boolean }) {
  const sorted = displaySort(cards);
  const suitRow = (suit: number) => sorted.filter((c) => cardSuit(c) === suit).map((c) => RANK_CHARS[cardRank(c)]);
  return (
    <div className={`deal-hand${mine ? ' deal-mine' : ''}`}>
      <b className="deal-hand-label">
        {SEAT_NAMES[seat]}
        {mine ? ' · YOU' : dummy ? ' · DUMMY' : ''}
      </b>
      {[0, 1, 2, 3].map((suit) => {
        const ranks = suitRow(suit);
        return (
          <div key={suit} className="deal-suit-row num">
            <span className={suitClass(suit)}>{SUIT_SYMBOLS[suit]}</span> {ranks.length ? ranks.join(' ') : '—'}
          </div>
        );
      })}
    </div>
  );
}

/**
 * THE DEAL — the four-hand diagram on the board result, built from the
 * allHands payload (revealed only once a board is done). The hand the human
 * actually played (South, or North on flipped boards) is emphasized.
 */
export function DealDiagram({
  hands,
  dealer,
  vul,
  playedSeat = 2,
  dummy,
}: {
  hands: number[][];
  dealer: number;
  vul: { ns: boolean; ew: boolean };
  playedSeat?: number;
  dummy?: number;
}) {
  const vulText = vul.ns && vul.ew ? 'All vul' : vul.ns ? 'NS vul' : vul.ew ? 'EW vul' : 'None vul';
  const cell = (seat: number) => (
    <HandCell seat={seat} cards={hands[seat]} mine={seat === playedSeat} dummy={seat === dummy} />
  );
  return (
    <div className="deal-diagram">
      <div className="deal-head">
        <span className="label-caps">The deal</span>
        <span className="deal-conditions">
          Dealer {SEAT_SHORT[dealer]} · {vulText}
        </span>
      </div>
      <div className="deal-grid">
        <div />
        {cell(0)}
        <div />
        {cell(3)}
        <div className="deal-compass">
          <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
            <line x1="24" y1="14" x2="24" y2="34" stroke="var(--line)" strokeWidth="1.5" />
            <line x1="14" y1="24" x2="34" y2="24" stroke="var(--line)" strokeWidth="1.5" />
            <text x="24" y="10" textAnchor="middle" fontFamily="'Besley Variable', Besley, serif" fontWeight="700" fontSize="10" fill="var(--ink)">
              N
            </text>
            <text x="24" y="45" textAnchor="middle" fontFamily="'Besley Variable', Besley, serif" fontSize="10" fill="var(--muted)">
              S
            </text>
            <text x="7" y="27.5" textAnchor="middle" fontFamily="'Besley Variable', Besley, serif" fontSize="10" fill="var(--muted)">
              W
            </text>
            <text x="41" y="27.5" textAnchor="middle" fontFamily="'Besley Variable', Besley, serif" fontSize="10" fill="var(--muted)">
              E
            </text>
          </svg>
        </div>
        {cell(1)}
        <div />
        {cell(2)}
        <div />
      </div>
    </div>
  );
}
