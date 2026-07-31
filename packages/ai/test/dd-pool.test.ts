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

  // Scheduling, on a ONE-worker pool — the production topology (Fly's
  // performance-1x), and the only size where dispatch order is observable
  // without racing. All three requests below are issued in the same tick, so
  // the first occupies the worker and the other two are queued behind it
  // before any of them can finish; what's asserted is which of the two the
  // freed worker takes next.
  const priorityReq = (n: number) => buildSolveRequest(dealBoard('pool-priority', (n % 4) + 1), contract, []);

  it('gives a freed worker to a later interactive request over a queued background one', async () => {
    const p = new DdPool(1, workerUrl);
    try {
      const order: string[] = [];
      const first = p.solve(priorityReq(1)).then(() => order.push('first'));
      const background = p.solve(priorityReq(2), 'background').then(() => order.push('background'));
      const interactive = p.solve(priorityReq(3), 'interactive').then(() => order.push('interactive'));
      await Promise.all([first, background, interactive]);
      expect(order).toEqual(['first', 'interactive', 'background']);
    } finally {
      await p.destroy();
    }
  }, 60_000);

  it('promotes a background request that has waited out the starvation bound', async () => {
    // Same shape, but with a 1ms bound: by the time the first (whole-board)
    // solve frees the worker the queued background request has aged past it,
    // so it is promoted and — being the older of the two — goes first. Without
    // promotion it would lose to the interactive request indefinitely.
    const p = new DdPool(1, workerUrl, 1);
    try {
      const order: string[] = [];
      const first = p.solve(priorityReq(1)).then(() => order.push('first'));
      const background = p.solve(priorityReq(2), 'background').then(() => order.push('background'));
      const interactive = p.solve(priorityReq(3), 'interactive').then(() => order.push('interactive'));
      await Promise.all([first, background, interactive]);
      expect(order).toEqual(['first', 'background', 'interactive']);
    } finally {
      await p.destroy();
    }
  }, 60_000);

  it('destroy() rejects nothing in flight when idle and terminates workers', async () => {
    const p = new DdPool(1, workerUrl);
    await expect(p.destroy()).resolves.toBeUndefined();
    await expect(p.solve(buildSolveRequest(dealBoard('x', 1), contract, []))).rejects.toThrow();
  });
});

/**
 * Pool DEATH, which play-ai.ts's solveVia discriminates on: a rejection whose
 * next getSharedDdPool() lookup yields a different pool means the old one
 * died and the replacement is worth a retry. Pointing a pool at a module that
 * doesn't exist takes the same route a crashing worker does —
 * worker.on('error') → fail() — so this needs no compiled worker and runs
 * whether or not the build has been done, unlike the suite above.
 */
describe('DdPool failure', () => {
  const missing = new URL('./no-such-dd-worker.js', import.meta.url);
  const req = () => buildSolveRequest(dealBoard('pool-fail', 1), contract, []);

  it('goes unusable and rejects its callers when a worker fails', async () => {
    const p = new DdPool(1, missing);
    // Worker failure is asynchronous, so a pool is handed out healthy and
    // dies afterwards — which is exactly how a live decision's K solves come
    // to reject together, mid-flight, rather than being caught on lookup.
    expect(p.usable).toBe(true);
    await expect(p.solve(req())).rejects.toThrow();
    expect(p.usable).toBe(false);
    await p.destroy();
  });

  it('tolerates destroy() after it has already failed', async () => {
    // getSharedDdPool() destroys a degraded pool when replacing it, to free
    // the workers its dead sibling left running — so this is load-bearing
    // rather than hygiene, and it must not throw back into the lookup.
    const p = new DdPool(1, missing);
    await expect(p.solve(req())).rejects.toThrow();
    await expect(p.destroy()).resolves.toBeUndefined();
    await expect(p.destroy()).resolves.toBeUndefined();
  });
});
