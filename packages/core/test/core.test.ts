import { describe, expect, it } from 'vitest';
import {
  auctionState,
  applyCall,
  boardConditions,
  boardScoreNS,
  contractScore,
  dealBoard,
  dealToPbn,
  DOUBLE,
  eloUpdates,
  explainBid,
  finalContract,
  hcp,
  legalCalls,
  legalCards,
  makeBid,
  makeCard,
  matchpoints,
  PASS,
  pbnToDeal,
  playState,
  REDOUBLE,
  trickWinner,
  Contract,
  Seat,
} from '../src/index.js';

const NONE = { ns: false, ew: false };
const BOTH = { ns: true, ew: true };
const contract = (level: number, strain: number, declarer: Seat, dbl = false, rdbl = false): Contract => ({
  level,
  strain: strain as Contract['strain'],
  declarer,
  doubled: dbl,
  redoubled: rdbl,
});

describe('deal', () => {
  it('is deterministic per seed and board', () => {
    const a = dealBoard('seed-1', 1);
    const b = dealBoard('seed-1', 1);
    const c = dealBoard('seed-2', 1);
    expect(dealToPbn(a)).toEqual(dealToPbn(b));
    expect(dealToPbn(a)).not.toEqual(dealToPbn(c));
  });

  it('deals 52 unique cards, 13 per hand', () => {
    const deal = dealBoard('x', 3);
    const all = deal.hands.flat();
    expect(all.length).toBe(52);
    expect(new Set(all).size).toBe(52);
  });

  it('board conditions follow duplicate rotation', () => {
    expect(boardConditions(1)).toEqual({ dealer: 0, vul: { ns: false, ew: false } });
    expect(boardConditions(2)).toEqual({ dealer: 1, vul: { ns: true, ew: false } });
    expect(boardConditions(3)).toEqual({ dealer: 2, vul: { ns: false, ew: true } });
    expect(boardConditions(4)).toEqual({ dealer: 3, vul: { ns: true, ew: true } });
  });

  it('round-trips PBN', () => {
    const deal = dealBoard('pbn', 2);
    const pbn = dealToPbn(deal);
    const back = pbnToDeal(pbn, deal.dealer, deal.vul);
    expect(back.hands).toEqual(deal.hands);
  });

  it('counts HCP', () => {
    // ♠A K, ♥Q J, ♦T 9, ♣2 → 4+3+2+1 = 10
    const cards = [makeCard(0, 12), makeCard(0, 11), makeCard(1, 10), makeCard(1, 9), makeCard(2, 8), makeCard(2, 7), makeCard(3, 0)];
    expect(hcp(cards)).toBe(10);
  });
});

describe('auction', () => {
  it('passes out after four passes', () => {
    const s = auctionState(0, [PASS, PASS, PASS, PASS]);
    expect(s.isOver).toBe(true);
    expect(s.passedOut).toBe(true);
    expect(finalContract(0, [PASS, PASS, PASS, PASS])).toBeNull();
  });

  it('ends after a bid and three passes', () => {
    const calls = [makeBid(1, 4), PASS, PASS, PASS];
    const s = auctionState(0, calls);
    expect(s.isOver).toBe(true);
    const c = finalContract(0, calls)!;
    expect(c.level).toBe(1);
    expect(c.strain).toBe(4);
    expect(c.declarer).toBe(0);
  });

  it('declarer is first of side to name the strain', () => {
    // N opens 1♥ (strain 2), E pass, S raises 2♥, all pass → declarer N
    const calls = [makeBid(1, 2), PASS, makeBid(2, 2), PASS, PASS, PASS];
    expect(finalContract(0, calls)!.declarer).toBe(0);
  });

  it('double/redouble legality', () => {
    // N bids 1NT: E may double but not redouble
    let s = auctionState(0, [makeBid(1, 4)]);
    expect(legalCalls(s)[DOUBLE]).toBe(true);
    expect(legalCalls(s)[REDOUBLE]).toBe(false);
    // after E doubles, S (N's partner) may redouble but not double
    s = auctionState(0, [makeBid(1, 4), DOUBLE]);
    expect(s.turn).toBe(2);
    expect(legalCalls(s)[REDOUBLE]).toBe(true);
    expect(legalCalls(s)[DOUBLE]).toBe(false);
    // E cannot double partner W's bid
    s = auctionState(0, [PASS, PASS, PASS, makeBid(1, 3)]);
    expect(s.turn).toBe(0);
    expect(legalCalls(s)[DOUBLE]).toBe(true);
    s = auctionState(3, [makeBid(1, 3), PASS]);
    expect(s.turn).toBe(1);
    expect(legalCalls(s)[DOUBLE]).toBe(false);
  });

  it('rejects illegal calls', () => {
    expect(() => applyCall(0, [makeBid(1, 4)], makeBid(1, 0))).toThrow();
    expect(() => applyCall(0, [], DOUBLE)).toThrow();
  });
});

describe('play', () => {
  it('follows suit and tracks tricks', () => {
    const deal = dealBoard('play-test', 1);
    const c = contract(1, 4, 0); // 1NT by N, lead from E
    let state = playState(deal, c, []);
    expect(state.handToPlay).toBe(1);
    const legal = legalCards(deal, state);
    expect(legal.length).toBe(13);
  });

  it('trick winner respects trump and led suit', () => {
    // trump ♥ (strain 2). Trick: ♠A led, then ♥2 ruff wins over ♠K
    const trick = [
      { seat: 0 as Seat, card: makeCard(0, 12) }, // ♠A
      { seat: 1 as Seat, card: makeCard(1, 0) }, // ♥2 (ruff)
      { seat: 2 as Seat, card: makeCard(0, 11) }, // ♠K
      { seat: 3 as Seat, card: makeCard(0, 0) }, // ♠2
    ];
    expect(trickWinner(trick, 2)).toBe(1);
    // NT: ♠A wins
    expect(trickWinner(trick, 4)).toBe(0);
  });
});

describe('scoring', () => {
  it('scores standard contracts', () => {
    expect(contractScore(contract(3, 4, 2), NONE, 9)).toBe(400); // 3NT= nv
    expect(contractScore(contract(3, 4, 2), BOTH, 9)).toBe(600); // 3NT= vul
    expect(contractScore(contract(4, 3, 2), NONE, 10)).toBe(420); // 4♠= nv
    expect(contractScore(contract(4, 3, 2), BOTH, 11)).toBe(650); // 4♠+1 vul
    expect(contractScore(contract(2, 2, 2), NONE, 8)).toBe(110); // 2♥= partscore
    expect(contractScore(contract(6, 4, 2), BOTH, 12)).toBe(1440); // 6NT= vul
    expect(contractScore(contract(7, 3, 2), NONE, 13)).toBe(1510); // 7♠= nv
    expect(contractScore(contract(1, 0, 2), NONE, 7)).toBe(70); // 1♣=
  });

  it('scores doubled contracts', () => {
    expect(contractScore(contract(2, 2, 2, true), NONE, 8)).toBe(470); // 2♥X= nv
    expect(contractScore(contract(3, 4, 2, true), BOTH, 10)).toBe(950); // 3NTX+1 vul
    expect(contractScore(contract(1, 4, 2, false, true), NONE, 7)).toBe(560); // 1NTXX= nv
  });

  it('scores undertricks', () => {
    expect(contractScore(contract(4, 3, 2), NONE, 8)).toBe(-100); // -2 nv
    expect(contractScore(contract(4, 3, 2), BOTH, 8)).toBe(-200); // -2 vul
    expect(contractScore(contract(3, 4, 2, true), NONE, 5)).toBe(-800); // 3NTX-4 nv: 100+200+200+300
    expect(contractScore(contract(3, 4, 2, true), BOTH, 6)).toBe(-800); // X-3 vul: 200+300+300
    expect(contractScore(contract(2, 0, 2, false, true), NONE, 6)).toBe(-600); // XX-2 nv: 200+400
  });

  it('boardScoreNS flips for EW declarers', () => {
    expect(boardScoreNS(contract(3, 4, 1), NONE, 9)).toBe(-400);
    expect(boardScoreNS(contract(3, 4, 1), NONE, 8)).toBe(50);
    expect(boardScoreNS(null, NONE, 0)).toBe(0);
  });

  it('matchpoints a field', () => {
    const res = matchpoints([420, 420, 170, -50]);
    expect(res[0].mp).toBe(2.5);
    expect(res[2].mp).toBe(1);
    expect(res[3].mp).toBe(0);
    expect(res[0].pct).toBeCloseTo(83.33, 1);
    expect(matchpoints([100])[0].pct).toBe(50);
  });
});

describe('elo', () => {
  it('updates pairwise and conserves total', () => {
    const res = eloUpdates([
      { userId: 1, rating: 1200, totalPct: 60 },
      { userId: 2, rating: 1200, totalPct: 50 },
      { userId: 3, rating: 1200, totalPct: 40 },
    ]);
    expect(res[0].after).toBeGreaterThan(1200);
    expect(res[2].after).toBeLessThan(1200);
    const total = res.reduce((s, r) => s + r.after - r.before, 0);
    expect(Math.abs(total)).toBeLessThanOrEqual(2); // rounding only
  });
});

describe('sayc explainer', () => {
  it('explains openings', () => {
    expect(explainBid(0, [], makeBid(1, 4))!.points).toBe('15–17 HCP');
    expect(explainBid(0, [], makeBid(2, 0))!.artificial).toBe(true);
    expect(explainBid(0, [], makeBid(2, 3))!.title).toContain('Weak two');
    expect(explainBid(0, [], makeBid(1, 3))!.shapePromise).toContain('5+');
  });

  it('explains Stayman and transfers', () => {
    const calls = [makeBid(1, 4), PASS];
    expect(explainBid(0, calls, makeBid(2, 0))!.title).toBe('Stayman');
    expect(explainBid(0, calls, makeBid(2, 1))!.title).toContain('transfer to ♥');
    expect(explainBid(0, calls, makeBid(2, 2))!.title).toContain('transfer to ♠');
  });

  it('explains responses and doubles', () => {
    const oneHeart = [makeBid(1, 2), PASS];
    expect(explainBid(0, oneHeart, makeBid(2, 2))!.title).toContain('Single raise');
    expect(explainBid(0, oneHeart, makeBid(3, 2))!.title).toContain('Limit raise');
    // takeout double: N opens 1♥, E to act
    expect(explainBid(0, [makeBid(1, 2)], DOUBLE)!.title).toBe('Takeout double');
    // negative double: N 1♦, E 1♠, S to act
    expect(explainBid(0, [makeBid(1, 1), makeBid(1, 3)], DOUBLE)!.title).toBe('Negative double');
  });

  it('explains Blackwood', () => {
    const calls = [makeBid(1, 3), PASS, makeBid(3, 3), PASS];
    expect(explainBid(0, calls, makeBid(4, 4))!.title).toContain('Blackwood');
  });

  it('always returns something for legal mid-auction bids', () => {
    const calls = [makeBid(1, 0), makeBid(1, 3), makeBid(2, 1), PASS];
    const m = explainBid(0, calls, makeBid(3, 0));
    expect(m).not.toBeNull();
    expect(m!.description.length).toBeGreaterThan(10);
  });
});
