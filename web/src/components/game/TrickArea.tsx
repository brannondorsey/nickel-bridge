import { SEAT_SHORT, type BoardView } from '../../api';
import { PlayingCard } from './PlayingCard';

/**
 * The trick-in-progress box: compass card slots, a dashed placeholder at the
 * seat about to play, and the DECL·DEF flip counter. When the board is
 * flipped (human declaring from North) the compass rotates 180° so the hand
 * the human plays stays at the bottom.
 */
export function TrickArea({ board }: { board: BoardView }) {
  const seats: { pos: string; seat: number }[] = board.flipped
    ? [
        { pos: 's', seat: 0 },
        { pos: 'w', seat: 1 },
        { pos: 'n', seat: 2 },
        { pos: 'e', seat: 3 },
      ]
    : [
        { pos: 'n', seat: 0 },
        { pos: 'e', seat: 1 },
        { pos: 's', seat: 2 },
        { pos: 'w', seat: 3 },
      ];
  const trick = board.currentTrick ?? [];
  const showTrick = trick.length ? trick : (board.lastTrick ?? []);
  const showingLast = trick.length === 0 && (board.lastTrick?.length ?? 0) > 0;
  const trickNo = Math.min((board.completedTricks ?? 0) + 1, 13);

  const seatTag = (seat: number) => {
    const roles: string[] = [SEAT_SHORT[seat]];
    if (seat === board.declarer) roles.push('DECL');
    if (seat === board.dummy) roles.push('DUMMY');
    if (seat === (board.playingSeat ?? 2) && seat === board.declarer) roles.push('YOU');
    return roles.join(' · ');
  };

  return (
    <div className="trick">
      {seats.map(({ pos, seat }) => {
        const played = showTrick.find((t) => t.seat === seat);
        const awaited = !showingLast && !played && board.handToPlay === seat;
        return (
          <div key={pos} className={`seatpos ${pos}`}>
            <span className="seat-label">{seatTag(seat)}</span>
            {played ? <PlayingCard card={played.card} small /> : awaited ? <PlayingCard placeholder small /> : <div className="trick-empty" />}
          </div>
        );
      })}
      <div className="tricks-count">
        <div className="tricks-cells num">
          <span className="tricks-cell tricks-decl">{board.declarerTricks ?? 0}</span>
          <span className="tricks-cell">{board.defenderTricks ?? 0}</span>
        </div>
        <div className="tricks-caption">
          DECL · DEF
          <br />
          {showingLast ? 'LAST TRICK' : `TRICK ${trickNo} OF 13`}
        </div>
      </div>
    </div>
  );
}
