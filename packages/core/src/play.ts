import { Card, Contract, Deal, Seat, Strain, cardRank, cardSuit, nextSeat, partnerOf } from './types.js';

/**
 * Trick-play state, derived purely from (deal, contract, plays).
 * plays is the flat sequence of cards in play order, starting with the
 * opening lead by the player left of declarer.
 */
export interface PlayState {
  contract: Contract;
  plays: Card[];
  /** seat to play next (declarer acts for dummy) */
  turn: Seat;
  /** whose hand the next card comes from */
  handToPlay: Seat;
  currentTrick: { seat: Seat; card: Card }[];
  completedTricks: { seat: Seat; card: Card }[][];
  declarerTricks: number;
  defenderTricks: number;
  isOver: boolean;
  dummy: Seat;
  dummyVisible: boolean;
}

export function trumpSuit(strain: Strain): number | null {
  // strain 0=♣ 1=♦ 2=♥ 3=♠ 4=NT; our suits 0=♠ 1=♥ 2=♦ 3=♣
  return strain === 4 ? null : 3 - strain;
}

export function trickWinner(trick: { seat: Seat; card: Card }[], strain: Strain): Seat {
  const trump = trumpSuit(strain);
  const ledSuit = cardSuit(trick[0].card);
  let best = trick[0];
  for (const play of trick.slice(1)) {
    const suit = cardSuit(play.card);
    const bestSuit = cardSuit(best.card);
    if (trump !== null && suit === trump && bestSuit !== trump) {
      best = play;
    } else if (suit === bestSuit && cardRank(play.card) > cardRank(best.card)) {
      best = play;
    }
  }
  return best.seat;
}

export function playState(deal: Deal, contract: Contract, plays: Card[]): PlayState {
  const dummy = partnerOf(contract.declarer);
  const opening = nextSeat(contract.declarer);
  const completedTricks: { seat: Seat; card: Card }[][] = [];
  let currentTrick: { seat: Seat; card: Card }[] = [];
  let leader: Seat = opening;
  let declarerTricks = 0;
  let defenderTricks = 0;

  for (const card of plays) {
    const seat = currentTrick.length === 0 ? leader : ((currentTrick[currentTrick.length - 1].seat + 1) % 4) as Seat;
    currentTrick.push({ seat, card });
    if (currentTrick.length === 4) {
      const winner = trickWinner(currentTrick, contract.strain);
      completedTricks.push(currentTrick);
      currentTrick = [];
      leader = winner;
      if (winner % 2 === contract.declarer % 2) declarerTricks++;
      else defenderTricks++;
    }
  }

  const handToPlay =
    currentTrick.length === 0 ? leader : (((currentTrick[currentTrick.length - 1].seat + 1) % 4) as Seat);
  const isOver = completedTricks.length === 13;
  return {
    contract,
    plays,
    turn: handToPlay === dummy ? contract.declarer : handToPlay,
    handToPlay,
    currentTrick,
    completedTricks,
    declarerTricks,
    defenderTricks,
    isOver,
    dummy,
    dummyVisible: plays.length >= 1,
  };
}

/** Cards remaining in a hand given the play history. */
export function remainingCards(deal: Deal, plays: Card[], seat: Seat): Card[] {
  const played = new Set(plays);
  return deal.hands[seat].filter((c) => !played.has(c));
}

/** Legal cards for the hand currently required to play. */
export function legalCards(deal: Deal, state: PlayState): Card[] {
  if (state.isOver) return [];
  const hand = remainingCards(deal, state.plays, state.handToPlay);
  if (state.currentTrick.length === 0) return hand;
  const ledSuit = cardSuit(state.currentTrick[0].card);
  const follow = hand.filter((c) => cardSuit(c) === ledSuit);
  return follow.length > 0 ? follow : hand;
}

export function applyPlay(deal: Deal, state: PlayState, card: Card): Card[] {
  if (!legalCards(deal, state).includes(card)) {
    throw new Error(`illegal card ${card}`);
  }
  return [...state.plays, card];
}
