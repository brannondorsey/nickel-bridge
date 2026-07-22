import { describe, expect, it } from 'vitest';
import {
  auctionState,
  applyCall,
  applyPlay,
  bidCategory,
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
  remainingCards,
  REDOUBLE,
  scoreBreakdown,
  trickWinner,
  trumpSuit,
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

  it('board conditions follow the full standard 16-board rotation', () => {
    // dealer rotates N E S W; vulnerability follows the standard duplicate cycle
    const expected: [number, boolean, boolean][] = [
      [0, false, false], [1, true, false], [2, false, true], [3, true, true],
      [0, true, false], [1, false, true], [2, true, true], [3, false, false],
      [0, false, true], [1, true, true], [2, false, false], [3, true, false],
      [0, true, true], [1, false, false], [2, true, false], [3, false, true],
    ];
    expected.forEach(([dealer, ns, ew], i) => {
      expect(boardConditions(i + 1), `board ${i + 1}`).toEqual({ dealer, vul: { ns, ew } });
    });
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

  it('declarer follows the strain even when the last bidder is partner', () => {
    // N 1♣, E pass, S 1♥, W pass, N 2♥ (supports S's hearts), all pass → S declares
    const calls = [makeBid(1, 0), PASS, makeBid(1, 2), PASS, makeBid(2, 2), PASS, PASS, PASS];
    const c = finalContract(0, calls)!;
    expect(c.declarer).toBe(2);
    expect(c.strain).toBe(2);
  });

  it('a new bid clears an earlier double', () => {
    // N 1♠, E X, S 2♠, all pass → contract undoubled
    const calls = [makeBid(1, 3), DOUBLE, makeBid(2, 3), PASS, PASS, PASS];
    const c = finalContract(0, calls)!;
    expect(c.doubled).toBe(false);
    expect(c.redoubled).toBe(false);
  });

  it('redouble sticks until the next bid, and nothing is doublable after it', () => {
    const calls = [makeBid(1, 4), DOUBLE, REDOUBLE];
    const s = auctionState(0, calls);
    expect(s.redoubled).toBe(true);
    const mask = legalCalls(s);
    expect(mask[DOUBLE]).toBe(false);
    expect(mask[REDOUBLE]).toBe(false);
    const done = finalContract(0, [...calls, PASS, PASS, PASS])!;
    expect(done.redoubled).toBe(true);
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

describe('bid category', () => {
  it('classifies passes and doubles regardless of context', () => {
    expect(bidCategory(0, [], PASS)).toBe('pass');
    expect(bidCategory(0, [makeBid(1, 3)], DOUBLE)).toBe('double');
    expect(bidCategory(0, [makeBid(1, 3), DOUBLE], REDOUBLE)).toBe('double');
  });

  it('the first bid of the auction is an opening, even after passes', () => {
    expect(bidCategory(0, [], makeBid(1, 4))).toBe('opening');
    expect(bidCategory(0, [PASS, PASS, PASS], makeBid(1, 2))).toBe('opening');
  });

  it('bids after partner opened are responses, including responder rebids', () => {
    // N opens 1♣, E passes, S responds 1♥
    expect(bidCategory(0, [makeBid(1, 0), PASS], makeBid(1, 2))).toBe('response');
    // ... N rebids 1NT, E passes, S's second bid is still in the response bucket
    expect(bidCategory(0, [makeBid(1, 0), PASS, makeBid(1, 2), PASS, makeBid(1, 4), PASS], makeBid(2, 2))).toBe(
      'response',
    );
    // interference between partner's opening and the response doesn't change it
    expect(bidCategory(0, [makeBid(1, 0), makeBid(1, 3)], makeBid(2, 2))).toBe('response');
  });

  it('later bids by the opener are rebids', () => {
    // S opens 1♠ (dealer S), W passes, N raises, E passes, S rebids
    expect(bidCategory(2, [makeBid(1, 3), PASS, makeBid(2, 3), PASS], makeBid(4, 3))).toBe('rebid');
  });

  it('bids over the opponents’ opening are overcalls, advances included', () => {
    // E opens 1♦ (dealer E), S overcalls 1♠
    expect(bidCategory(1, [makeBid(1, 1)], makeBid(1, 3))).toBe('overcall');
    // W opens, N overcalls, E passes, S advances — still the overcall bucket
    expect(bidCategory(3, [makeBid(1, 1), makeBid(1, 2), PASS], makeBid(2, 2))).toBe('overcall');
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

  it('trumpSuit maps bid strain to suit, and NT to null', () => {
    expect(trumpSuit(0)).toBe(3); // ♣ bid strain -> ♣ suit
    expect(trumpSuit(1)).toBe(2); // ♦ -> ♦
    expect(trumpSuit(2)).toBe(1); // ♥ -> ♥
    expect(trumpSuit(3)).toBe(0); // ♠ -> ♠
    expect(trumpSuit(4)).toBeNull(); // NT
  });

  it('highest trump wins an all-trump trick; overruff beats ruff', () => {
    const allTrump = [
      { seat: 0 as Seat, card: makeCard(1, 3) }, // ♥5 led
      { seat: 1 as Seat, card: makeCard(1, 12) }, // ♥A
      { seat: 2 as Seat, card: makeCard(1, 7) },
      { seat: 3 as Seat, card: makeCard(1, 0) },
    ];
    expect(trickWinner(allTrump, 2)).toBe(1);
    const overruff = [
      { seat: 0 as Seat, card: makeCard(0, 12) }, // ♠A led
      { seat: 1 as Seat, card: makeCard(1, 0) }, // ♥2 ruff
      { seat: 2 as Seat, card: makeCard(1, 5) }, // ♥7 overruff
      { seat: 3 as Seat, card: makeCard(0, 2) },
    ];
    expect(trickWinner(overruff, 2)).toBe(2);
    // off-suit discard never wins in NT: highest of the LED suit wins
    const discard = [
      { seat: 0 as Seat, card: makeCard(2, 3) }, // ♦5 led
      { seat: 1 as Seat, card: makeCard(0, 12) }, // ♠A discard
      { seat: 2 as Seat, card: makeCard(2, 6) }, // ♦8
      { seat: 3 as Seat, card: makeCard(3, 12) }, // ♣A discard
    ];
    expect(trickWinner(discard, 4)).toBe(2);
  });

  it('enforces following suit when able', () => {
    const deal = dealBoard('follow-suit', 1);
    const c = contract(1, 4, 0); // 1NT by N, E leads
    // pick a lead from E in a suit South also holds — must follow
    const southSuits = new Set(deal.hands[2].map((card) => Math.floor(card / 13)));
    const lead = deal.hands[1].find((card) => southSuits.has(Math.floor(card / 13)))!;
    expect(lead).toBeDefined();
    const state = playState(deal, c, [lead]);
    expect(state.handToPlay).toBe(2);
    const ledSuit = Math.floor(lead / 13);
    const legal = legalCards(deal, state);
    expect(legal.length).toBeGreaterThan(0);
    expect(legal.every((card) => Math.floor(card / 13) === ledSuit)).toBe(true);
    const offSuit = deal.hands[2].find((x) => Math.floor(x / 13) !== ledSuit)!;
    expect(() => applyPlay(deal, state, offSuit)).toThrow();
  });

  it('remainingCards shrinks as cards are played', () => {
    const deal = dealBoard('remaining', 1);
    const c = contract(1, 4, 0);
    const state = playState(deal, c, []);
    const lead = legalCards(deal, state)[0];
    const after = playState(deal, c, [lead]);
    expect(remainingCards(deal, after.plays, 1).length).toBe(12);
    expect(remainingCards(deal, after.plays, 2).length).toBe(13);
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

  it('matches the official duplicate scoring table (doubled/redoubled rows)', () => {
    // [level, strain, doubled, redoubled, vul, tricksTaken, official score]
    const TABLE: [number, number, boolean, boolean, boolean, number, number][] = [
      // doubled partscores/games made (insult bonus included)
      [1, 4, true, false, false, 7, 180], // 1NTX= nv
      [2, 0, true, false, true, 8, 180], // 2♣X= vul (80 + 50 + 50)
      [3, 0, true, false, false, 9, 470], // 3♣X= nv → doubled into game
      [2, 2, true, false, false, 8, 470], // 2♥X= nv
      [4, 3, true, false, true, 11, 990], // 4♠X+1 vul
      [6, 2, true, false, false, 12, 1210], // 6♥X= nv
      // redoubled
      [1, 4, false, true, true, 7, 760], // 1NTXX= vul → game
      [2, 1, false, true, false, 10, 960], // 2♦XX+2 nv: 160+300+2×200+100
      [7, 4, false, true, true, 13, 2980], // 7NTXX= vul (maximum score)
      // doubled undertricks, not vulnerable: -100, -300, -500, -800, -1100
      [3, 4, true, false, false, 8, -100],
      [3, 4, true, false, false, 7, -300],
      [3, 4, true, false, false, 6, -500],
      [3, 4, true, false, false, 5, -800],
      [3, 4, true, false, false, 4, -1100],
      // doubled undertricks, vulnerable: -200, -500, -800, -1100
      [3, 4, true, false, true, 8, -200],
      [3, 4, true, false, true, 7, -500],
      [3, 4, true, false, true, 6, -800],
      [3, 4, true, false, true, 5, -1100],
      // redoubled undertricks
      [2, 3, false, true, false, 7, -200],
      [2, 3, false, true, false, 6, -600],
      [2, 3, false, true, false, 5, -1000],
      [2, 3, false, true, false, 4, -1600],
      [2, 3, false, true, true, 7, -400],
      [2, 3, false, true, true, 6, -1000],
      // undoubled sanity anchors
      [1, 0, false, false, false, 6, -50],
      [7, 4, false, false, true, 6, -700],
    ];
    for (const [level, strain, dbl, rdbl, vul, tricks, expected] of TABLE) {
      const v = vul ? BOTH : NONE;
      expect(
        contractScore(contract(level, strain, 2, dbl, rdbl), v, tricks),
        `${level}${'♣♦♥♠N'[strain]}${rdbl ? 'XX' : dbl ? 'X' : ''} ${vul ? 'vul' : 'nv'} taking ${tricks}`,
      ).toBe(expected);
    }
  });

  it('scoreBreakdown lines sum to contractScore for every contract', () => {
    // Exhaustive: every level/strain/doubling/vulnerability/trick count.
    for (let level = 1; level <= 7; level++) {
      for (let strain = 0; strain <= 4; strain++) {
        for (const [dbl, rdbl] of [[false, false], [true, false], [false, true]] as const) {
          for (const vul of [NONE, BOTH]) {
            for (let tricks = 0; tricks <= 13; tricks++) {
              const c = contract(level, strain, 2, dbl, rdbl);
              const b = scoreBreakdown(c, vul, tricks);
              const label = `${level}${'♣♦♥♠N'[strain]}${rdbl ? 'XX' : dbl ? 'X' : ''} taking ${tricks}`;
              expect(b.total, label).toBe(contractScore(c, vul, tricks));
              expect(b.lines.reduce((s, l) => s + l.amount, 0), label).toBe(b.total);
            }
          }
        }
      }
    }
  });

  it('scoreBreakdown itemizes the components', () => {
    // 4♠= vul: odd tricks 120 + game bonus 500
    const made = scoreBreakdown(contract(4, 3, 2), BOTH, 10);
    expect(made.lines.map((l) => [l.kind, l.amount])).toEqual([
      ['odd-tricks', 120],
      ['game-bonus', 500],
    ]);
    expect(made.lines[0].detail).toBe('4 × 30');
    expect(made.vulnerable).toBe(true);

    // 3NTX+1 vul: (3×30+10)×2 = 200, game 500, insult 50, overtrick 200
    const dbl = scoreBreakdown(contract(3, 4, 2, true), BOTH, 10);
    expect(dbl.lines.map((l) => [l.kind, l.amount])).toEqual([
      ['odd-tricks', 200],
      ['game-bonus', 500],
      ['insult-bonus', 50],
      ['overtricks', 200],
    ]);
    expect(dbl.lines[0].detail).toBe('(3 × 30 + 10) × 2');

    // 6NT= vul: slam bonus present, partscore absent
    const slam = scoreBreakdown(contract(6, 4, 2), BOTH, 12);
    expect(slam.lines.map((l) => l.kind)).toEqual(['odd-tricks', 'game-bonus', 'slam-bonus']);

    // 2♥= nv partscore
    const part = scoreBreakdown(contract(2, 2, 2), NONE, 8);
    expect(part.lines.map((l) => [l.kind, l.amount])).toEqual([
      ['odd-tricks', 60],
      ['partscore-bonus', 50],
    ]);

    // 3NTX−4 nv: single penalty line with the compressed progression
    const down = scoreBreakdown(contract(3, 4, 2, true), NONE, 5);
    expect(down.lines).toEqual([
      { kind: 'undertricks', label: 'Down 4', detail: '100 + 2 × 200 + 300, doubled not vulnerable', amount: -800 },
    ]);
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
