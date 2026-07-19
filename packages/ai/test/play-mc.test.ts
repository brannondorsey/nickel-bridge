import { describe, expect, it } from 'vitest';
import {
  Card,
  Contract,
  Deal,
  PASS,
  RANK_CHARS,
  Seat,
  Suit,
  dealBoard,
  hcp,
  makeBid,
  makeCard,
  seededRng,
} from '@bridge/core';
import { chooseCard } from '../src/play-ai.js';
import {
  chooseCardSampled,
  deriveKnowledge,
  hoistAuctionConstraints,
  inferVoids,
  mcDecisionSeed,
  sampleLayouts,
} from '../src/play-mc.js';

const rank = (ch: string) => RANK_CHARS.indexOf(ch as (typeof RANK_CHARS)[number]);
const card = (suit: Suit, ch: string): Card => makeCard(suit, rank(ch));

const SPADE: Suit = 0;
const HEART: Suit = 1;

/** Same "last N tricks" micro-deal helper as play-ai.test.ts. */
function microDeal(north: Card[], east: Card[], south: Card[], west: Card[]): Deal {
  const sort = (h: Card[]) => [...h].sort((a, b) => a - b);
  return { hands: [sort(north), sort(east), sort(south), sort(west)], dealer: 0, vul: { ns: false, ew: false } };
}

// South declares notrump: opening leader is West.
const contract: Contract = { level: 3, strain: 4, declarer: 2, doubled: false, redoubled: false };

// A quiet all-pass auction for tests that don't exercise constraints. Note it
// is NOT a legal complete auction (a real pass-out never reaches play), but
// hoistAuctionConstraints only reads prefixes, so it serves as neutral input.
const quietCalls = [PASS, PASS, PASS, PASS];

describe('mcDecisionSeed', () => {
  it('binds tournament seed, board, and decision index', () => {
    expect(mcDecisionSeed('abc', 3, 17)).toBe('abc#board3#mc17');
  });
});

describe('inferVoids', () => {
  it('marks a seat void in the led suit when it discards', () => {
    // West leads ♠A; North follows ♠3; East discards ♥2 → East void in spades.
    const plays = [card(SPADE, 'A'), card(SPADE, '3'), card(HEART, '2')];
    const voids = inferVoids(contract, plays);
    expect(voids[1][SPADE]).toBe(true); // East (seat 1)
    expect(voids[1][HEART]).toBe(false);
    expect(voids[0][SPADE]).toBe(false); // North followed
    expect(voids[3][SPADE]).toBe(false); // West led it
  });
});

describe('deriveKnowledge', () => {
  const deal = microDeal(
    [card(SPADE, '3'), card(SPADE, '4')],
    [card(SPADE, 'K'), card(SPADE, '2')],
    [card(SPADE, '5'), card(SPADE, '6')],
    [card(SPADE, 'A'), card(SPADE, 'Q')],
  );

  it('opening leader (pre-dummy) sees only their own hand', () => {
    const know = deriveKnowledge(deal, contract, [], 0, quietCalls);
    expect(know.actor).toBe(3); // West on lead
    expect([...know.knownHands.keys()]).toEqual([3]);
  });

  it('a defender after the lead sees own hand plus dummy', () => {
    // After West's lead it is North (dummy, declarer South) to play — actor is
    // declarer. Play on: after dummy's card, East (defender) is to play.
    const plays = [card(SPADE, 'A'), card(SPADE, '3')];
    const know = deriveKnowledge(deal, contract, plays, 0, quietCalls);
    expect(know.actor).toBe(1); // East
    expect(new Set(know.knownHands.keys())).toEqual(new Set([1, 0])); // own + dummy (North)
  });

  it('when dummy is on play the actor is declarer, knowing own hand + dummy', () => {
    const plays = [card(SPADE, 'A')]; // West led; North (dummy) to play
    const know = deriveKnowledge(deal, contract, plays, 0, quietCalls);
    expect(know.handToPlay).toBe(0);
    expect(know.actor).toBe(2); // South declarer acts for dummy
    expect(new Set(know.knownHands.keys())).toEqual(new Set([2, 0]));
  });

  it('never exposes hidden hands anywhere in the struct', () => {
    const know = deriveKnowledge(deal, contract, [], 0, quietCalls);
    // Hidden seats: N, E, S. Their cards must not appear outside the public deck.
    const visible = new Set(know.knownHands.get(3));
    for (const seat of [0, 1, 2] as Seat[]) {
      for (const c of deal.hands[seat]) expect(visible.has(c)).toBe(false);
    }
    expect(know.playedBySeat.every((p) => p.length === 0)).toBe(true);
    expect(know.remainingCounts).toEqual([2, 2, 2, 2]);
    expect(know.deck).toHaveLength(8);
  });
});

describe('hoistAuctionConstraints', () => {
  it('collects exact reqs per seat, evaluated against each call prefix', () => {
    // Dealer North opens 1♠ (13+ HCP, 5+ spades), East passes over it
    // (generic — no req), South responds. The 1♠ req must come from the
    // empty prefix, not the finished auction.
    const calls = [makeBid(1, 3), PASS];
    const cons = hoistAuctionConstraints(0, calls);
    expect(cons[0].length).toBe(1);
    expect(cons[0][0].fromPass).toBe(false);
    expect(cons[0][0].req.suits?.some((s) => s.strain === 3 && (s.min ?? 0) >= 5)).toBe(true);
    expect(cons[1].length).toBe(0); // pass over interference is generic
  });

  it('flags pass-derived constraints (opening-seat pass promises ≤12 HCP)', () => {
    const cons = hoistAuctionConstraints(0, [PASS, makeBid(1, 3)]);
    expect(cons[0].length).toBe(1);
    expect(cons[0][0].fromPass).toBe(true);
    expect(cons[0][0].req.maxHcp).toBe(12);
  });
});

describe('sampleLayouts', () => {
  it('honors voids and bid constraints in every returned layout', () => {
    // Full board. West (hidden) has bid 1♠ per the auction; every sampled
    // West hand must satisfy the opening req, and a play-shown void must hold.
    const deal = dealBoard('play-mc-test', 1);
    const calls = [makeBid(1, 3), PASS]; // dealer (N=0 in dealBoard? use deal.dealer) — recompute below
    const dealer = deal.dealer;
    const know = deriveKnowledge(deal, contract, [], dealer, calls);
    const cons = hoistAuctionConstraints(dealer, calls);
    const rng = seededRng('constraint-test');
    const layouts = sampleLayouts(know, cons, 20, rng);
    expect(layouts.reduce((s, l) => s + l.weight, 0)).toBe(20);
    const constrainedSeat = dealer; // made the 1♠ call
    for (const layout of layouts) {
      if (know.knownHands.has(constrainedSeat)) break; // constraint applies only if hidden
      const hand = layout.deal.hands[constrainedSeat];
      expect(hcp(hand)).toBeGreaterThanOrEqual(cons[constrainedSeat][0].req.minHcp ?? 0);
    }
    // Every layout must reproduce the known hands exactly.
    for (const layout of layouts) {
      for (const [seat, hand] of know.knownHands) {
        expect(layout.deal.hands[seat]).toEqual([...hand].sort((a, b) => a - b));
      }
    }
  });

  it('relaxes pass constraints when the pool makes them unsatisfiable, keeping k layouts', () => {
    // West is the actor; the 9 hidden cards (N/E/S) are ALL queens or better,
    // so any sampled 3-card East hand holds ≥ 6 HCP. A pass-derived maxHcp 5
    // on East can never be satisfied — level 0 must exhaust and the ladder
    // must drop the pass constraint yet still deliver k layouts.
    const deal = microDeal(
      [card(SPADE, 'A'), card(SPADE, 'K'), card(SPADE, 'Q')],
      [card(HEART, 'A'), card(HEART, 'K'), card(HEART, 'Q')],
      [card(2, 'A'), card(2, 'K'), card(2, 'Q')],
      [card(SPADE, '2'), card(SPADE, '3'), card(SPADE, '4')],
    );
    const know = deriveKnowledge(deal, contract, [], 0, quietCalls);
    const cons: ReturnType<typeof hoistAuctionConstraints> = [[], [], [], []];
    cons[1].push({ fromPass: true, req: { maxHcp: 5 } });
    const layouts = sampleLayouts(know, cons, 8, seededRng('ladder-test'));
    expect(layouts.reduce((s, l) => s + l.weight, 0)).toBe(8);
    expect(layouts.length).toBeGreaterThan(0);
  });

  it('keeps bid constraints while relaxing pass constraints', () => {
    // Same all-honors pool, but East also "bid" something requiring 6+ HCP —
    // trivially true here. After the ladder drops the impossible pass
    // constraint, the bid constraint must still be honored in every layout.
    const deal = microDeal(
      [card(SPADE, 'A'), card(SPADE, 'K'), card(SPADE, 'Q')],
      [card(HEART, 'A'), card(HEART, 'K'), card(HEART, 'Q')],
      [card(2, 'A'), card(2, 'K'), card(2, 'Q')],
      [card(SPADE, '2'), card(SPADE, '3'), card(SPADE, '4')],
    );
    const know = deriveKnowledge(deal, contract, [], 0, quietCalls);
    const cons: ReturnType<typeof hoistAuctionConstraints> = [[], [], [], []];
    cons[1].push({ fromPass: true, req: { maxHcp: 5 } }); // unsatisfiable
    cons[1].push({ fromPass: false, req: { minHcp: 9 } }); // satisfiable: needs ≥ QQQ... only via ≥1 ace/king combo
    const layouts = sampleLayouts(know, cons, 8, seededRng('ladder-test-2'));
    expect(layouts.reduce((s, l) => s + l.weight, 0)).toBe(8);
    for (const layout of layouts) {
      expect(hcp(layout.deal.hands[1])).toBeGreaterThanOrEqual(9);
    }
  });

  it('dedupes: a void-determined endgame collapses to one weighted entry', () => {
    // Declarer South, dummy North (visible after the lead). W wins trick 1
    // with ♠A while East shows out of spades. Actor W then knows: hidden E and
    // S hold {♥3, ♠6} between them, and E's void forces E=♥3, S=♠6 — a single
    // possible layout no matter how many samples are drawn.
    const deal = microDeal(
      [card(SPADE, '3'), card(SPADE, '4')], // N (dummy, visible)
      [card(HEART, '2'), card(HEART, '3')], // E (hidden, void in ♠)
      [card(SPADE, '5'), card(SPADE, '6')], // S (hidden)
      [card(SPADE, 'A'), card(HEART, 'A')], // W (actor)
    );
    const plays = [card(SPADE, 'A'), card(SPADE, '3'), card(HEART, '2'), card(SPADE, '5')];
    const know = deriveKnowledge(deal, contract, plays, 0, quietCalls);
    const layouts = sampleLayouts(know, [[], [], [], []], 16, seededRng('dedupe-test'));
    expect(layouts.reduce((s, l) => s + l.weight, 0)).toBe(16);
    expect(layouts.length).toBe(1); // fully determined by voids + counts
    expect(layouts[0].deal.hands).toEqual(deal.hands); // and it IS the true layout
  });
});

describe('chooseCardSampled', () => {
  const deal = microDeal(
    [card(SPADE, '3'), card(SPADE, '4'), card(HEART, '3')],
    [card(SPADE, 'K'), card(SPADE, '2'), card(HEART, '4')],
    [card(SPADE, '5'), card(SPADE, '6'), card(HEART, '5')],
    [card(SPADE, 'A'), card(SPADE, 'Q'), card(HEART, '2')],
  );
  const opts = { k: 8, seed: mcDecisionSeed('trace', 1, 0), dealer: 0 as Seat, calls: quietCalls };

  it('is deterministic: identical inputs give the identical card', async () => {
    const a = await chooseCardSampled(deal, contract, [], opts);
    const b = await chooseCardSampled(deal, contract, [], { ...opts });
    expect(a).toBe(b);
  });

  it('a different seed may sample differently but still returns a legal card', async () => {
    const c = await chooseCardSampled(deal, contract, [], { ...opts, seed: mcDecisionSeed('other', 1, 0) });
    expect(deal.hands[3]).toContain(c);
  });

  it('useAuction: false ignores auction constraints entirely (voids still bind)', async () => {
    // The all-honors pool from the ladder test: with auction awareness, level
    // 0 can never satisfy the pass constraint and the ladder must grind
    // through its budgets. Blind mode never consults constraints at all — it
    // must return a legal card deterministically, and repeat runs agree.
    const d = microDeal(
      [card(SPADE, 'A'), card(SPADE, 'K'), card(SPADE, 'Q')],
      [card(HEART, 'A'), card(HEART, 'K'), card(HEART, 'Q')],
      [card(2, 'A'), card(2, 'K'), card(2, 'Q')],
      [card(SPADE, '2'), card(SPADE, '3'), card(SPADE, '4')],
    );
    // An auction whose hoisted constraints WOULD bind (opening-seat passes).
    const blindOpts = { ...opts, useAuction: false, seed: 'blind-1' };
    const a = await chooseCardSampled(d, contract, [], blindOpts);
    const b = await chooseCardSampled(d, contract, [], { ...blindOpts });
    expect(a).toBe(b);
    expect(d.hands[3]).toContain(a); // West on lead — legal card from the true hand
  });

  it('equals true-DD chooseCard when the position is fully inferable', async () => {
    // Three-card version of the void-determined endgame: after trick 1, W
    // still holds two cards (a real choice), and E's spade void pins every
    // hidden card — sampling can only ever see the true layout, so sampled
    // play must equal perfect play.
    const d = microDeal(
      [card(SPADE, '3'), card(SPADE, '4'), card(HEART, '6')], // N (dummy)
      [card(HEART, '2'), card(HEART, '3'), card(HEART, '4')], // E (void in ♠)
      [card(SPADE, '5'), card(SPADE, '6'), card(SPADE, '7')], // S
      [card(SPADE, 'A'), card(SPADE, 'K'), card(HEART, 'A')], // W (actor, on lead)
    );
    const plays = [card(SPADE, 'A'), card(SPADE, '3'), card(HEART, '2'), card(SPADE, '5')];
    const sampled = await chooseCardSampled(d, contract, plays, { ...opts, seed: 'x' });
    const perfect = await chooseCard(d, contract, plays);
    expect(sampled).toBe(perfect);
  });

  describe('playTopN (card-selection noise)', () => {
    it('omitted, or 1, is byte-identical to the pre-existing argmax behavior', async () => {
      for (const playTopN of [undefined, 1]) {
        const withOpt = await chooseCardSampled(deal, contract, [], { ...opts, playTopN });
        const without = await chooseCardSampled(deal, contract, [], opts);
        expect(withOpt).toBe(without);
      }
    });

    it('is deterministic: identical inputs give the identical card', async () => {
      const noisy = { ...opts, playTopN: 3 };
      const a = await chooseCardSampled(deal, contract, [], noisy);
      const b = await chooseCardSampled(deal, contract, [], { ...noisy });
      expect(a).toBe(b);
    });

    it('always returns a legal card at any playTopN', async () => {
      for (const playTopN of [2, 3, 8]) {
        const c = await chooseCardSampled(deal, contract, [], { ...opts, playTopN, seed: mcDecisionSeed('legal-check', 1, 0) });
        expect(deal.hands[3]).toContain(c);
      }
    });

    it('a forced (single-legal-card) node ignores playTopN and consumes no rng', async () => {
      // West down to one card: forced regardless of noise settings.
      const forced = microDeal(
        [card(SPADE, '3'), card(HEART, '3')],
        [card(SPADE, 'K'), card(HEART, '4')],
        [card(SPADE, '5'), card(HEART, '5')],
        [card(SPADE, 'A')],
      );
      const c = await chooseCardSampled(forced, contract, [], { ...opts, playTopN: 8 });
      expect(c).toBe(card(SPADE, 'A'));
    });

    it('sometimes deviates from the playTopN=1 argmax, across many decisions', async () => {
      let deviations = 0;
      for (let i = 0; i < 30; i++) {
        const seed = mcDecisionSeed('noise-sweep', 1, i);
        const argmax = await chooseCardSampled(deal, contract, [], { ...opts, seed });
        const noisy = await chooseCardSampled(deal, contract, [], { ...opts, seed, playTopN: 4 });
        if (noisy !== argmax) deviations++;
      }
      expect(deviations).toBeGreaterThan(0);
    });
  });
});
