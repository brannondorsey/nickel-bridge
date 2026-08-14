import { useLayoutEffect, useRef, useState } from 'react';
import { RANK_CHARS, SUIT_SYMBOLS, cardRank, cardSuit, displaySort } from '../../api';
import { fanMarginLeft } from './fanLayout';
import { capturePlayOrigin, motionOK } from './playAnim';
import { PlayingCard } from './PlayingCard';
import { drawTiming } from './trumpDraw';

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
 *
 * The fan LAYS OUT its own cards (displaySort), so `cards` is a hand rather
 * than an order — callers hand over what is held and say which suit, if any,
 * leads it. That is what lets the re-sort be an animation rather than a jump:
 * both orders are derivable here, from one prop, at any moment.
 */
export function HandFan({
  cards,
  legal,
  selected,
  onSelect,
  small = false,
  hint = null,
  trump = null,
  drawIn = false,
}: {
  cards: number[];
  legal?: number[];
  selected?: number | null;
  onSelect?: (card: number) => void;
  small?: boolean;
  /** first-crossing tour: pulse this card as the tollkeeper's suggestion */
  hint?: number | null;
  /** suit to lay out first ("Trump placement · LEFT SIDE"); null = plain ♠♥♦♣ */
  trump?: number | null;
  /** play the Draw into that order once, on mount — see the note below */
  drawIn?: boolean;
}) {
  const interactive = Boolean(onSelect);
  const fanRef = useRef<HTMLDivElement>(null);
  /**
   * The Draw (trumpDraw.ts) has to start from an order that was never on
   * screen: the fan the auction ended with lives in BiddingPhase, and this
   * one mounts with PlayPhase, so there is no previous render of THIS element
   * to animate away from.
   *
   * So the mount itself supplies it. `drawing` makes the first render lay the
   * cards out in plain suit order; the layout effect below measures them
   * there, drops the flag, and the re-render — still before the browser has
   * painted either frame — lands them trump-left, which is the "last" half of
   * an ordinary FLIP. The player sees one motion, starting from a position
   * that only ever existed between two layout passes.
   *
   * Captured once, in the initializer, so the flag is a property of this
   * mount rather than of the prop: a `drawIn` left true for the rest of the
   * board (it is — Board.tsx has nothing to clear it against) can never
   * re-sort a hand twice.
   */
  const [drawing, setDrawing] = useState(() => drawIn && trump !== null && motionOK());
  /**
   * A card in flight is not a card you can tap, which is this screen's rule
   * everywhere else: a staged snapshot holds `myTurn: false` and drops
   * `legalCards` precisely so nothing can be played at a board that is still
   * moving. The Draw needs the same guard on its own account, because the one
   * case it does NOT cover is the player being on LEAD — there are no robot
   * cards to stage, so the fan arrives live and tappable with the trumps
   * still travelling. Measured on a real 3♣ board: ~500ms of moving targets.
   * Only the tap is withheld, never the cards' look — `dimmed` still follows
   * `legal` alone, so nothing changes on screen as this clears.
   */
  const [inFlight, setInFlight] = useState(false);
  const firstLefts = useRef<Map<number, number> | null>(null);

  const ordered = displaySort(cards, drawing ? null : trump);

  useLayoutEffect(() => {
    const fan = fanRef.current;
    if (!fan) return;
    if (drawing) {
      firstLefts.current = new Map(
        [...fan.children].map((el) => [Number((el as HTMLElement).dataset.card), el.getBoundingClientRect().left]),
      );
      setDrawing(false);
      return;
    }
    const first = firstLefts.current;
    if (!first) return;
    firstLefts.current = null;
    const flights = playDraw(fan, first, trump);
    if (!flights.length) return;
    setInFlight(true);
    Promise.allSettled(flights).then(() => setInFlight(false));
    // `drawing` is the whole trigger: this runs twice per mount at most (once
    // to measure, once to play) and never again, since firstLefts is cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing]);

  return (
    <div ref={fanRef} className={`handfan${interactive ? ' interactive' : ''}${small ? ' handfan-sm' : ''}`}>
      {ordered.map((c, i) => {
        const playable = interactive && !inFlight && (!legal || legal.includes(c));
        const dimmed = legal !== undefined && !legal.includes(c);
        const newSuit = i > 0 && cardSuit(c) !== cardSuit(ordered[i - 1]);
        return (
          <button
            key={c}
            type="button"
            data-card={c}
            className={`cardbtn${selected === c ? ' selected' : ''}${newSuit ? ' suitgap' : ''}${hint === c && selected !== c ? ' card-hint' : ''}`}
            style={i > 0 ? { marginLeft: fanMarginLeft(ordered[i - 1], small) } : undefined}
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

/**
 * The DOM half of the Draw: invert each card to where it used to be, then
 * release it — the non-trumps together, opening the gap, and the trumps one
 * at a time into it.
 *
 * A trump card is lifted (translateY at the midpoint) and given a z-index for
 * the flight, because .cardbtn sets `isolation: isolate` and document order
 * would otherwise paint it under the cards it is passing over — the same
 * reason the fan's own stacking is left alone everywhere else.
 *
 * Cards that do not move are skipped outright rather than animated by zero:
 * on a heart contract the diamonds and clubs sit at exactly the same x
 * before and after, and giving them an animation that changes nothing costs a
 * composited layer per card for no visible reason.
 *
 * Every animation is CANCELLED once finished, and that is load-bearing rather
 * than tidiness. `fill: 'both'` is what holds a card at its old position
 * during the delay before it is drawn, but a finished forwards fill keeps
 * overriding the element's transform for as long as it exists — including
 * `.handfan .cardbtn.selected`'s lift, so the very next card the player
 * selected would stay flat for the rest of the board. The final keyframe is
 * the resting position, so cancelling changes nothing on screen.
 *
 * Returns a promise per card that actually moved, so the caller knows when
 * the fan has stopped being a moving target.
 */
function playDraw(fan: HTMLElement, firstLefts: Map<number, number>, trump: number | null): Promise<unknown>[] {
  if (trump === null) return [];
  const cards = [...fan.children] as HTMLElement[];
  const trumps = cards.filter((el) => cardSuit(Number(el.dataset.card)) === trump).length;
  const timing = drawTiming(trumps);
  const ease = 'cubic-bezier(.2,.7,.2,1)';

  const flights: Promise<unknown>[] = [];
  let drawn = 0;
  for (const el of cards) {
    const card = Number(el.dataset.card);
    const from = firstLefts.get(card);
    if (from === undefined) continue;
    const dx = from - el.getBoundingClientRect().left;
    if (Math.abs(dx) < 0.5) continue;
    const isTrump = cardSuit(card) === trump;

    if (isTrump) el.style.zIndex = '3';
    const anim = el.animate(
      isTrump
        ? [
            { transform: `translate(${dx}px, 0)` },
            { transform: `translate(${dx * 0.4}px, -20px)`, offset: 0.55 },
            { transform: 'translate(0, 0)' },
          ]
        : [{ transform: `translate(${dx}px, 0)` }, { transform: 'translate(0, 0)' }],
      isTrump
        ? { duration: timing.cardMs, delay: timing.lead + drawn++ * timing.stagger, easing: ease, fill: 'both' }
        : { duration: timing.restMs, easing: ease, fill: 'both' },
    );
    const settle = () => {
      anim.cancel();
      el.style.zIndex = '';
    };
    flights.push(anim.finished.then(settle, settle));
  }
  return flights;
}
