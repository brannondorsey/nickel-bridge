import { describe, expect, it } from 'vitest';
import { Card, Contract, Deal, RANK_CHARS, Suit, makeCard } from '@bridge/core';
import type { FutureTricks } from '../vendor/bridge-dds/api.js';
import { SolveSource, buildSolveRequest, solveRequest, solveVia } from '../src/play-ai.js';

/**
 * The pool-vs-main-thread policy, driven with stub pools so it runs without a
 * built worker (getSharedDdPool needs dist/dd-worker.js, which vitest's TS
 * sources don't have — see dd-pool.test.ts's `built` guard). What matters
 * here is which source answers, not the tricks: the main thread blocks the
 * event loop for the whole solve, so reaching it when a worker could have
 * answered is the bug this policy exists to prevent.
 */

const rank = (ch: string) => RANK_CHARS.indexOf(ch as (typeof RANK_CHARS)[number]);
const card = (suit: Suit, ch: string): Card => makeCard(suit, rank(ch));
const contract: Contract = { level: 3, strain: 4, declarer: 2, doubled: false, redoubled: false };

// Two cards each: the main-thread solve of this is fast enough to sit in a
// unit test, which is what lets the fall-through cases assert a real result.
const deal: Deal = {
  hands: [
    [card(0, '3'), card(0, '4')],
    [card(0, 'K'), card(0, '2')],
    [card(0, '5'), card(0, '6')],
    [card(0, 'A'), card(0, 'Q')],
  ],
  dealer: 0,
  vul: { ns: false, ew: false },
};
const req = buildSolveRequest(deal, contract, []);

/** A pool whose answer is identifiable — `nodes` carries the tag. */
function stubPool(tag: number): SolveSource & { calls: number } {
  return {
    calls: 0,
    async solve() {
      this.calls++;
      return { nodes: tag, cards: 0, suit: [], rank: [], equals: [], score: [] } satisfies FutureTricks;
    },
  };
}

/** A pool that rejects the way a degraded or timed-out one does. */
function deadPool(): SolveSource & { calls: number } {
  return {
    calls: 0,
    async solve() {
      this.calls++;
      throw new Error('dd pool is degraded');
    },
  };
}

describe('solveVia', () => {
  it('answers from the pool when there is one', async () => {
    const pool = stubPool(11);
    expect((await solveVia(req, 'interactive', () => pool)).nodes).toBe(11);
    expect(pool.calls).toBe(1);
  });

  it('forwards the priority it was given', async () => {
    const seen: string[] = [];
    const pool: SolveSource = {
      async solve(_r, priority) {
        seen.push(priority);
        return { nodes: 0, cards: 0, suit: [], rank: [], equals: [], score: [] };
      },
    };
    await solveVia(req, 'background', () => pool);
    await solveVia(req, 'interactive', () => pool);
    expect(seen).toEqual(['background', 'interactive']);
  });

  it('retries on the replacement pool when the first one dies', async () => {
    // getSharedDdPool() replaces a pool it finds unusable, so the second call
    // hands back a different, healthy one — worth a retry rather than
    // dropping a whole Promise.all of layouts onto the main thread.
    const dead = deadPool();
    const fresh = stubPool(22);
    let handedOut = 0;
    const getPool = () => (handedOut++ === 0 ? dead : fresh);
    expect((await solveVia(req, 'interactive', getPool)).nodes).toBe(22);
    expect(dead.calls).toBe(1);
    expect(fresh.calls).toBe(1);
  });

  it('does not retry the same pool — that rejection was a timeout', async () => {
    // Still usable means the request timed out rather than the pool dying.
    // Re-queueing it would land behind the same backlog, so this is the one
    // case that legitimately reaches the main thread.
    const pool = deadPool();
    const result = await solveVia(req, 'interactive', () => pool);
    expect(pool.calls).toBe(1);
    expect(result.score).toEqual((await solveRequest(req)).score);
  });

  it('falls back to the main thread when the replacement dies too', async () => {
    const first = deadPool();
    const second = deadPool();
    let handedOut = 0;
    const result = await solveVia(req, 'interactive', () => (handedOut++ === 0 ? first : second));
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
    expect(result.score).toEqual((await solveRequest(req)).score);
  });

  it('uses the main thread when no worker pool exists at all', async () => {
    // Running from TS sources (vitest) or an unbuilt checkout — the main
    // thread is the only instance there is, and blocking is correct.
    const result = await solveVia(req, 'interactive', () => null);
    expect(result.score).toEqual((await solveRequest(req)).score);
  });
});
