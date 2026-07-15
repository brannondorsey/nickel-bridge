import { describe, expect, it } from 'vitest';
import { Card, Contract, Deal, RANK_CHARS, Suit, makeCard } from '@bridge/core';
import { chooseCard, solveFutureTricks } from '../src/play-ai.js';

const rank = (ch: string) => RANK_CHARS.indexOf(ch as (typeof RANK_CHARS)[number]);
const card = (suit: Suit, ch: string): Card => makeCard(suit, rank(ch));

const SPADE: Suit = 0;
const HEART: Suit = 1;

/**
 * A tiny "last N tricks" deal: hands hold only the cards still in play, the
 * same shape DDS already solves near the end of every real board — a
 * standard technique for exercising a double-dummy solver without needing a
 * full 52-card deal.
 */
function microDeal(north: Card[], east: Card[], south: Card[], west: Card[]): Deal {
  const sort = (h: Card[]) => [...h].sort((a, b) => a - b);
  return { hands: [sort(north), sort(east), sort(south), sort(west)], dealer: 0, vul: { ns: false, ew: false } };
}

// South declares notrump, so the opening leader (nextSeat of declarer) is
// West — `handToPlay` at plays=[] is always a defender, same as a real
// board's opening lead.
const contract: Contract = { level: 3, strain: 4, declarer: 2, doubled: false, redoubled: false };

describe('solveFutureTricks', () => {
  it('bestScore === remaining tricks when the side to move (here, the defense) is a 100% laydown', async () => {
    // West (defense, on lead) holds the top spade (A) and East holds the
    // 3rd-best (Q) — between them the defense pair's weakest card (Q) still
    // beats dummy/declarer's best (6), so defense wins every remaining
    // trick no matter the order.
    const deal = microDeal(
      [card(SPADE, '3'), card(SPADE, '4')], // North (dummy)
      [card(SPADE, 'K'), card(SPADE, '2')], // East (defense)
      [card(SPADE, '5'), card(SPADE, '6')], // South (declarer)
      [card(SPADE, 'A'), card(SPADE, 'Q')], // West (defense, on lead)
    );
    const solve = await solveFutureTricks(deal, contract, []);
    expect(solve.bestScore).toBe(2); // both remaining tricks
  });

  it('bestScore === 0 when the OTHER side (here, declarer) is the 100% laydown', async () => {
    // Dummy/declarer hold all four top cards (A, K, Q, J); defense holds
    // only the bottom four — declarer's weakest (J) already beats defense's
    // best (5), so defense can't force a single trick regardless of order.
    const deal = microDeal(
      [card(SPADE, 'A'), card(SPADE, 'K')], // North (dummy)
      [card(SPADE, '4'), card(SPADE, '2')], // East (defense)
      [card(SPADE, 'Q'), card(SPADE, 'J')], // South (declarer)
      [card(SPADE, '3'), card(SPADE, '5')], // West (defense, on lead)
    );
    const solve = await solveFutureTricks(deal, contract, []);
    expect(solve.bestScore).toBe(0); // defense can force nothing
  });

  it('a genuinely split position scores neither 0 nor the full remaining count', async () => {
    // Each side holds one suit's ace. Whichever suit West (defense) leads
    // first, that suit's ace-holder wins it and the other suit's ace wins
    // the second (fully forced) trick — a 1-1 split regardless of West's
    // choice of lead, verified by hand for both possible leads.
    const deal = microDeal(
      [card(SPADE, 'K'), card(HEART, 'A')], // North (dummy)
      [card(SPADE, '2'), card(HEART, 'K')], // East (defense)
      [card(SPADE, 'Q'), card(HEART, 'Q')], // South (declarer)
      [card(SPADE, 'A'), card(HEART, '2')], // West (defense, on lead)
    );
    const solve = await solveFutureTricks(deal, contract, []);
    expect(solve.bestScore).toBe(1);
    expect(solve.bestScore).not.toBe(0);
    expect(solve.bestScore).not.toBe(2);
  });
});

describe('chooseCard', () => {
  it('on a laydown, plays the deterministic tie-break winner (lowest rank first)', async () => {
    // Same layout as the defense-laydown case above: West's A and Q are
    // both fully winning, so the tie-break — not the raw DD score — decides
    // which one gets led.
    const deal = microDeal(
      [card(SPADE, '3'), card(SPADE, '4')],
      [card(SPADE, 'K'), card(SPADE, '2')],
      [card(SPADE, '5'), card(SPADE, '6')],
      [card(SPADE, 'A'), card(SPADE, 'Q')], // West on lead, both cards win either way
    );
    const first = await chooseCard(deal, contract, []);
    expect(first).toBe(card(SPADE, 'Q')); // Q ranks lower than A — tie-break picks it
  });
});
