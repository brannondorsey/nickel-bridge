import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Card, Contract, Deal, RANK_CHARS, Suit, dealBoard, makeCard } from '@bridge/core';
import { DdPool } from '../src/dd-pool.js';
import { buildSolveRequest, solveRequest } from '../src/play-ai.js';

// The pool spawns the COMPILED worker (dist/dd-worker.js) — vitest runs the
// TS sources, so these tests only run after `npm run build` (CI always builds
// first; locally run the build once).
const workerUrl = new URL('../dist/dd-worker.js', import.meta.url);
const built = workerUrl.protocol === 'file:' && existsSync(fileURLToPath(workerUrl));

const rank = (ch: string) => RANK_CHARS.indexOf(ch as (typeof RANK_CHARS)[number]);
const card = (suit: Suit, ch: string): Card => makeCard(suit, rank(ch));

function microDeal(north: Card[], east: Card[], south: Card[], west: Card[]): Deal {
  const sort = (h: Card[]) => [...h].sort((a, b) => a - b);
  return { hands: [sort(north), sort(east), sort(south), sort(west)], dealer: 0, vul: { ns: false, ew: false } };
}

const contract: Contract = { level: 3, strain: 4, declarer: 2, doubled: false, redoubled: false };

describe.skipIf(!built)('DdPool', () => {
  const pool = built ? new DdPool(2, workerUrl) : null;

  afterAll(async () => {
    await pool?.destroy();
  });

  it('returns the same FutureTricks as the main-thread instance', async () => {
    const deal = microDeal(
      [card(0, '3'), card(0, '4')],
      [card(0, 'K'), card(0, '2')],
      [card(0, '5'), card(0, '6')],
      [card(0, 'A'), card(0, 'Q')],
    );
    const req = buildSolveRequest(deal, contract, []);
    const [fromPool, fromMain] = await Promise.all([pool!.solve(req), solveRequest(req)]);
    expect(fromPool.cards).toBe(fromMain.cards);
    expect(fromPool.suit).toEqual(fromMain.suit);
    expect(fromPool.rank).toEqual(fromMain.rank);
    expect(fromPool.equals).toEqual(fromMain.equals);
    expect(fromPool.score).toEqual(fromMain.score);
  });

  it('correlates a concurrent batch of distinct requests correctly', async () => {
    // 8 different full boards solved at trick zero across 2 workers; each
    // result must match its own request's main-thread solve.
    const contracts: Contract[] = [0, 1, 2, 3].map((declarer) => ({
      level: 3,
      strain: 4,
      declarer: declarer as Contract['declarer'],
      doubled: false,
      redoubled: false,
    }));
    const reqs = Array.from({ length: 8 }, (_, i) =>
      buildSolveRequest(dealBoard('pool-batch', (i % 4) + 1), contracts[i % 4], []),
    );
    const pooled = await Promise.all(reqs.map((r) => pool!.solve(r)));
    for (let i = 0; i < reqs.length; i++) {
      const main = await solveRequest(reqs[i]);
      expect(pooled[i].score).toEqual(main.score);
      expect(pooled[i].suit).toEqual(main.suit);
      expect(pooled[i].rank).toEqual(main.rank);
    }
  }, 60_000);

  it('destroy() rejects nothing in flight when idle and terminates workers', async () => {
    const p = new DdPool(1, workerUrl);
    await expect(p.destroy()).resolves.toBeUndefined();
    await expect(p.solve(buildSolveRequest(dealBoard('x', 1), contract, []))).rejects.toThrow();
  });
});
