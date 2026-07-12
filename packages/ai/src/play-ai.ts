import {
  Card,
  Contract,
  Deal,
  PlayState,
  Seat,
  cardRank,
  cardSuit,
  handToPbn,
  legalCards,
  playState,
  remainingCards,
} from '@bridge/core';
// Vendored WASM build of Bo Haglund & Soren Hein's DDS (Apache-2.0),
// from github.com/bookchris/bridge-dds-js with its ESM import path fixed.
import { Dds, loadDds } from '../vendor/bridge-dds/api.js';

let ddsInstance: Dds | null = null;

export async function getDds(): Promise<Dds> {
  if (!ddsInstance) {
    ddsInstance = new Dds(await loadDds());
  }
  return ddsInstance;
}

/** our strain (0=♣..4=NT) → DDS trump (0=♠ 1=♥ 2=♦ 3=♣ 4=NT) */
function ddsTrump(strain: number): number {
  return strain === 4 ? 4 : 3 - strain;
}

/** our card → DDS suit (0=♠..3=♣ — same as ours) and rank (2..14) */
function ddsSuit(card: Card): number {
  return cardSuit(card);
}
function ddsRank(card: Card): number {
  return cardRank(card) + 2;
}

/**
 * Choose the double-dummy-optimal card for the hand to play.
 * Deterministic: among DD-equivalent cards, plays the lowest (rank, then
 * suit) — robots always produce the same play on the same deal, which keeps
 * duplicate comparison across players fair.
 */
export async function chooseCard(deal: Deal, contract: Contract, plays: Card[]): Promise<Card> {
  const state = playState(deal, contract, plays);
  const legal = legalCards(deal, state);
  if (legal.length === 0) throw new Error('no legal cards');
  if (legal.length === 1) return legal[0];

  const dds = await getDds();
  const leader = state.currentTrick.length > 0 ? state.currentTrick[0].seat : state.handToPlay;

  // remainCards: cards still held by all four hands (current-trick cards excluded)
  const remaining = ([0, 1, 2, 3] as Seat[]).map((s) => remainingCards(deal, plays, s));
  const pbn = 'N:' + remaining.map((h) => handToPbn(h)).join(' ');

  const currentTrickSuit = [0, 0, 0];
  const currentTrickRank = [0, 0, 0];
  state.currentTrick.forEach((p, i) => {
    currentTrickSuit[i] = ddsSuit(p.card);
    currentTrickRank[i] = ddsRank(p.card);
  });

  const res = dds.SolveBoardPBN(
    {
      trump: ddsTrump(contract.strain),
      first: leader,
      currentTrickSuit,
      currentTrickRank,
      remainCards: pbn,
    },
    -1, // target: find the maximum
    3, // solutions: score all legal cards
    0,
  );

  // FutureTricks.score[i] = tricks the side to move can take if card i is led/played.
  // `equals` is a bitmask of lower equivalent cards subsumed by entry i.
  let bestScore = -1;
  const scores = new Map<Card, number>();
  for (let i = 0; i < res.cards; i++) {
    const suit = res.suit[i] as 0 | 1 | 2 | 3;
    const cards = [res.rank[i], ...maskToRanks(res.equals[i])].map((r) => suit * 13 + (r - 2));
    for (const card of cards) scores.set(card, res.score[i]);
    if (res.score[i] > bestScore) bestScore = res.score[i];
  }
  const best = legal
    .filter((c) => (scores.get(c) ?? -1) === bestScore)
    .sort((a, b) => cardRank(a) - cardRank(b) || cardSuit(a) - cardSuit(b));
  if (best.length === 0) {
    // defensive: DDS disagreed about legality — never happens, but never stall a game
    return legal.sort((a, b) => cardRank(a) - cardRank(b))[0];
  }
  return best[0];
}

/** DDS `equals` bitmask (bit r set = rank r is equivalent) → ranks */
function maskToRanks(mask: number): number[] {
  const ranks: number[] = [];
  for (let r = 2; r <= 14; r++) if (mask & (1 << r)) ranks.push(r);
  return ranks;
}

export type { PlayState };
