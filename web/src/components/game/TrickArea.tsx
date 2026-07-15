import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RANK_CHARS, SEAT_SHORT, SUIT_SYMBOLS, cardRank, cardSuit, suitClass, type BoardView } from '../../api';
import { COLLECT_MS, GLIDE_MS, motionOK, takePlayOrigin, trickWinner } from './playAnim';
import { PlayingCard } from './PlayingCard';

/**
 * The trick-in-progress box: compass card slots, a dashed placeholder at the
 * seat about to play, and the DECL·DEF flip counter. When the board is
 * flipped (human declaring from North) the compass rotates 180° so the hand
 * the human plays stays at the bottom.
 *
 * Animations are diff-driven: Board.tsx applies server responses one play at
 * a time (playAnim.ts stagePlaySteps), and this component compares each new
 * view against the previous one. A card that just appeared glides in — from
 * the tapped fan card when HandFan recorded an origin, otherwise from
 * off-table on that seat's side. A trick that just cleared sweeps to the
 * winner, and a tally cell that just changed gets the stamp pop.
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
  const trickNo = Math.min((board.completedTricks ?? 0) + 1, 13);

  const boxRef = useRef<HTMLDivElement | null>(null);
  const slotEls = useRef(new Map<number, HTMLDivElement | null>());
  const flights = useRef(new Set<HTMLElement>());
  const prevRef = useRef<BoardView | null>(null);
  // which tally cell just changed (drives the stamp pop, cleared after it)
  const [stamp, setStamp] = useState<'decl' | 'def' | null>(null);

  useEffect(
    () => () => {
      flights.current.forEach((el) => el.remove());
      flights.current.clear();
    },
    [],
  );

  useLayoutEffect(() => {
    const prev = prevRef.current;
    prevRef.current = board;
    if (!prev || !motionOK() || !boxRef.current) return;
    if (prev.tournamentId !== board.tournamentId || prev.boardNo !== board.boardNo) return;

    const prevTrick = prev.currentTrick ?? [];
    const curTrick = board.currentTrick ?? [];
    const posOf = new Map(seats.map((s) => [s.seat, s.pos]));

    // trick just cleared with a completed-tricks bump → collect sweep
    if (prevTrick.length > 0 && curTrick.length === 0 && (board.completedTricks ?? 0) > (prev.completedTricks ?? 0)) {
      collectSweep(prevTrick, boxRef.current, slotEls.current, flights.current, winnerOf(prevTrick, board));
    } else {
      // cards that just appeared glide in
      const known = new Set(prevTrick.map((t) => t.card));
      for (const t of curTrick) {
        if (!known.has(t.card)) glideIn(t, boxRef.current, slotEls.current, flights.current, posOf.get(t.seat));
      }
    }

    // tally stamp on whichever count changed
    if ((board.declarerTricks ?? 0) !== (prev.declarerTricks ?? 0)) setStamp('decl');
    else if ((board.defenderTricks ?? 0) !== (prev.defenderTricks ?? 0)) setStamp('def');
  }, [board]);

  useEffect(() => {
    if (stamp === null) return;
    const id = window.setTimeout(() => setStamp(null), 500);
    return () => clearTimeout(id);
  }, [stamp]);

  const seatTag = (seat: number) => {
    const roles: string[] = [SEAT_SHORT[seat]];
    if (seat === board.declarer) roles.push('DECL');
    if (seat === board.dummy) roles.push('DUMMY');
    if (seat === (board.playingSeat ?? 2) && seat === board.declarer) roles.push('YOU');
    return roles.join(' · ');
  };

  return (
    <div className="trick" ref={boxRef}>
      {seats.map(({ pos, seat }) => {
        const played = trick.find((t) => t.seat === seat);
        const awaited = !played && board.handToPlay === seat;
        return (
          <div key={pos} className={`seatpos ${pos}`}>
            <span className="seat-label">{seatTag(seat)}</span>
            <div
              className="trick-slot"
              ref={(el) => {
                slotEls.current.set(seat, el);
              }}
            >
              {played ? <PlayingCard card={played.card} small /> : awaited ? <PlayingCard placeholder small /> : null}
            </div>
          </div>
        );
      })}
      <div className="tricks-count">
        <div className="tricks-cells num">
          <span className={`tricks-cell tricks-decl${stamp === 'decl' ? ' stamp' : ''}`}>
            {board.declarerTricks ?? 0}
          </span>
          <span className={`tricks-cell${stamp === 'def' ? ' stamp' : ''}`}>{board.defenderTricks ?? 0}</span>
        </div>
        <div className="tricks-caption">
          DECL · DEF
          <br />
          TRICK {trickNo} OF 13
        </div>
      </div>
    </div>
  );
}

/** Which seat takes this completed trick (contract strain, else server hint). */
function winnerOf(trick: { seat: number; card: number }[], board: BoardView): number {
  const strain = (board.contract as { strain?: number } | undefined)?.strain;
  if (strain !== undefined) return trickWinner(trick, strain);
  return board.handToPlay ?? trick[0].seat;
}

/** Imperative twin of PlayingCard for animation clones (kept in sync by eye). */
function makeCardEl(card: number, from: DOMRect): HTMLElement {
  const el = document.createElement('div');
  el.className = `pcard small ${suitClass(cardSuit(card))} pcard-flight`;
  const rank = RANK_CHARS[cardRank(card)];
  const rankEl = document.createElement('div');
  rankEl.className = `rank${rank === '10' ? ' ten' : ''}`;
  rankEl.textContent = rank;
  const suitEl = document.createElement('div');
  suitEl.className = 'suit';
  suitEl.textContent = SUIT_SYMBOLS[cardSuit(card)];
  el.append(rankEl, suitEl);
  el.style.left = `${from.left}px`;
  el.style.top = `${from.top}px`;
  el.style.width = `${from.width}px`;
  el.style.height = `${from.height}px`;
  return el;
}

/**
 * Glide a just-played card into its slot: from the fan card the user tapped
 * (recorded by HandFan) or from off-table on the seat's side of the box.
 */
function glideIn(
  play: { seat: number; card: number },
  box: HTMLDivElement,
  slots: Map<number, HTMLDivElement | null>,
  flights: Set<HTMLElement>,
  pos: string | undefined,
): void {
  const slot = slots.get(play.seat);
  const cardEl = slot?.querySelector<HTMLElement>('.pcard');
  if (!slot || !cardEl) return;
  const to = cardEl.getBoundingClientRect();
  if (to.width === 0) return; // not laid out (hidden tab, tests)

  const origin = takePlayOrigin(play.card);
  let from: { left: number; top: number; width: number; height: number };
  if (origin && origin.width > 0) {
    from = origin;
  } else {
    const b = box.getBoundingClientRect();
    const m = 14;
    from =
      pos === 'w'
        ? { left: b.left - to.width - m, top: to.top, width: to.width, height: to.height }
        : pos === 'e'
          ? { left: b.right + m, top: to.top, width: to.width, height: to.height }
          : pos === 'n'
            ? { left: to.left, top: b.top - to.height - m, width: to.width, height: to.height }
            : { left: to.left, top: b.bottom + m, width: to.width, height: to.height };
  }

  // clone at TARGET size so the pips stay proportional, scaled up to the
  // origin size at the start of the flight (fan cards are bigger than slots)
  const clone = cardEl.cloneNode(true) as HTMLElement;
  clone.classList.add('pcard-flight');
  clone.style.left = `${from.left}px`;
  clone.style.top = `${from.top}px`;
  clone.style.width = `${to.width}px`;
  clone.style.height = `${to.height}px`;
  document.body.appendChild(clone);
  flights.add(clone);
  cardEl.style.visibility = 'hidden';

  const startScale = from.width / to.width;
  const anim = clone.animate(
    [
      { transform: `translate(0, 0) scale(${startScale})`, easing: 'cubic-bezier(.22,.8,.25,1)' },
      { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(1)` },
    ],
    { duration: GLIDE_MS, fill: 'forwards' },
  );
  const done = () => {
    cardEl.style.visibility = '';
    clone.remove();
    flights.delete(clone);
  };
  anim.onfinish = done;
  anim.oncancel = done;
}

/** Sweep the four cards of a completed trick toward the winner and fade. */
function collectSweep(
  trick: { seat: number; card: number }[],
  box: HTMLDivElement,
  slots: Map<number, HTMLDivElement | null>,
  flights: Set<HTMLElement>,
  winner: number,
): void {
  const target = slots.get(winner)?.getBoundingClientRect();
  if (!target || target.width === 0) return;
  const jitter = [-3, 2, -1, 3];
  trick.forEach((t, i) => {
    const from = slots.get(t.seat)?.getBoundingClientRect();
    if (!from || from.width === 0) return;
    const clone = makeCardEl(t.card, from);
    document.body.appendChild(clone);
    flights.add(clone);
    const anim = clone.animate(
      [
        { transform: 'translate(0, 0) scale(1) rotate(0deg)', opacity: 1 },
        {
          transform: `translate(${target.left - from.left + jitter[i % 4]}px, ${
            target.top - from.top - 10
          }px) scale(.55) rotate(${jitter[i % 4] * 5}deg)`,
          opacity: 0,
        },
      ],
      { duration: COLLECT_MS, easing: 'ease-in', fill: 'forwards' },
    );
    const done = () => {
      clone.remove();
      flights.delete(clone);
    };
    anim.onfinish = done;
    anim.oncancel = done;
  });
}
