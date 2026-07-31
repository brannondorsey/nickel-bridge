import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { DealPbn, FutureTricks } from '../vendor/bridge-dds/api.js';

/**
 * A pool of worker threads, each holding its own DDS WASM instance, for
 * running many SolveBoardPBN calls in parallel — the sampled-DD chooser
 * (play-mc.ts) solves K layouts per robot decision and is the only caller
 * that needs this. Results are identical wherever a solve runs (DDS is
 * deterministic); the pool changes latency only, never outcomes, so robot
 * determinism is untouched.
 *
 * The pool is lazy and optional: getSharedDdPool() returns null when the
 * compiled worker isn't on disk (e.g. vitest running TS sources before a
 * build) or spawning fails, and callers fall back to sequential solving on
 * the main-thread instance. Workers are unref()ed so an idle pool never
 * keeps the process alive.
 *
 * PRIORITY: the benchmark AI personas (ai-players.ts) solve through this same
 * pool as real human requests (server/src/game.ts's advanceRobots), and on a
 * single-vCPU deployment (Fly's performance-1x — production, the demo app,
 * and every PR preview all run this) the pool collapses to exactly one
 * worker. Measured: with a background persona decision (K=8, the 'expert'
 * tier) running continuously against that one worker, a concurrent human
 * card-play decision's latency went from p50=85ms/p90=312ms (uncontended) to
 * p50=1.1s/p90=2.0s/p99=3.5s — the "occasional multi-second freeze on card
 * play" this pool's queueing exists to prevent. ai-players.ts's courtesyGap
 * reduces how OFTEN a persona decision is mid-flight when a human taps (it
 * won't START one during a quiet gap), but its COURTESY_CAP_MS deliberately
 * lets one proceed anyway after a bounded wait even during continuous human
 * play, and once dispatched, DDS's synchronous WASM call can't be preempted
 * mid-solve. So each solve() call carries a priority: an INTERACTIVE request
 * (default — every existing call site, unchanged) jumps ahead of any queued
 * BACKGROUND request (ai-players.ts's persona decisions, opted in explicitly)
 * for the next free worker. This can't shorten a solve already executing
 * inside a worker, but it stops a human's request from waiting behind a
 * whole persona decision's remaining UNSTARTED solves (up to K-1 of them) —
 * the bulk of the measured tail. Priority only changes WHICH worker a
 * request reaches and WHEN, never its result, so robot determinism
 * (invariant 1) is untouched by construction, same as the pool itself.
 *
 * That preference is deliberately BOUNDED (STARVATION_PROMOTE_MS), because
 * unbounded it reintroduces the same freeze through a different door. A
 * queued background request is jumped by every newly-arriving interactive
 * one, so under a sustained interactive backlog it can wait forever —
 * measured on a 1-worker pool with three interactive requests kept in
 * flight, a background solve starved past the full SOLVE_TIMEOUT_MS and
 * rejected. Its caller's catch then falls back to the MAIN-THREAD
 * solveRequest() (play-mc.ts, play-ai.ts), a synchronous WASM call with no
 * timeout that blocks the event loop for every concurrent request — strictly
 * worse than the contention this priority queue exists to relieve. So a
 * background request that has waited STARVATION_PROMOTE_MS is promoted to
 * interactive, capping its wait at that plus one in-flight solve, well
 * inside the timeout. The cost to a human is at most one extra background
 * solve per promotion window.
 */

/** cap: each worker holds a ~5 MB WASM heap; solves split K/size ways */
const POOL_SIZE = Math.max(1, Math.min(availableParallelism() - 1, 4));

/**
 * Deadline for one pool solve. DDS has a documented heavy tail — a real deal
 * once cost ~37s (see claim-soundness.test.ts) — and a wedged or lost worker
 * would otherwise stall its callers forever. On expiry the promise rejects
 * and the caller re-runs the SAME request on the main-thread instance:
 * timing may change WHERE a solve runs, never whether its result is used, so
 * robot determinism is untouched. A late worker reply after expiry is
 * discarded (its pending entry is gone).
 */
const SOLVE_TIMEOUT_MS = 15_000;

/** Lower sorts first: an INTERACTIVE request jumps a queued BACKGROUND one. */
const PRIORITY = { interactive: 0, background: 1 } as const;
export type SolvePriority = keyof typeof PRIORITY;

/**
 * How long a queued BACKGROUND request may be jumped before it is promoted
 * to interactive — the anti-starvation bound argued in this file's PRIORITY
 * doc comment. Well under SOLVE_TIMEOUT_MS: the promoted request still has
 * to wait out whichever solve is in flight when it wins, and the point is to
 * clear it long before the timeout drops its caller onto the blocking
 * main-thread path. This reads the wall clock, which decides only WHICH
 * queued request a freed worker takes next — the same latency-only lever as
 * priority itself, so invariant 1 is untouched (DDS is deterministic).
 */
const STARVATION_PROMOTE_MS = 5_000;

interface InFlight {
  resolve: (res: FutureTricks) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Queued extends InFlight {
  id: number;
  req: DealPbn;
  priority: number;
  enqueuedAt: number;
}

export class DdPool {
  private workers: Worker[] = [];
  /** true = this worker isn't currently running a solve */
  private idle: boolean[] = [];
  /** requests waiting for a free worker, not yet dispatched */
  private queue: Queued[] = [];
  /** dispatched requests awaiting their worker's reply, keyed by request id */
  private inFlight = new Map<number, InFlight>();
  private nextId = 1;
  private dead = false;

  /** overridable only so tests can exercise promotion without a 5s wait */
  constructor(
    size: number,
    workerUrl: URL,
    private readonly starvationMs: number = STARVATION_PROMOTE_MS,
  ) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerUrl);
      worker.unref();
      worker.on('message', (msg: { id: number; res?: FutureTricks; error?: string }) => {
        const p = this.inFlight.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this.inFlight.delete(msg.id);
          if (msg.error !== undefined) p.reject(new Error(msg.error));
          else p.resolve(msg.res!);
        } // else: timed out earlier — late reply discarded, worker is still newly free below
        this.idle[i] = true;
        this.dispatchNext(i);
      });
      worker.on('error', (err: unknown) => this.fail(err instanceof Error ? err : new Error(String(err))));
      worker.on('exit', (code) => {
        // ANY exit while requests are outstanding loses their replies — fail
        // so callers fall back, whatever the exit code claims.
        if (!this.dead && (code !== 0 || this.inFlight.size > 0 || this.queue.length > 0)) {
          this.fail(new Error(`dd-worker exited with code ${code}`));
        }
      });
      this.workers.push(worker);
      this.idle.push(true);
    }
  }

  /**
   * Hand the highest-priority waiting request (FIFO within a priority) to a
   * just-freed worker. A background request that has waited starvationMs
   * counts as interactive here, and since the queue stays in enqueue order it
   * is then the OLDEST interactive-priority item and wins outright — which is
   * what makes the bound a bound rather than a nudge.
   */
  private dispatchNext(workerIndex: number): void {
    if (this.dead || !this.idle[workerIndex] || this.queue.length === 0) return;
    const now = Date.now();
    const effective = (q: Queued): number =>
      now - q.enqueuedAt >= this.starvationMs ? PRIORITY.interactive : q.priority;
    let best = 0;
    let bestPriority = effective(this.queue[0]);
    for (let i = 1; i < this.queue.length; i++) {
      const p = effective(this.queue[i]);
      if (p < bestPriority) {
        best = i;
        bestPriority = p;
      }
    }
    const [item] = this.queue.splice(best, 1);
    this.idle[workerIndex] = false;
    this.inFlight.set(item.id, { resolve: item.resolve, reject: item.reject, timer: item.timer });
    this.workers[workerIndex].postMessage({ id: item.id, req: item.req });
  }

  /** reject everything queued or in flight and mark the pool unusable (callers fall back) */
  private fail(err: Error): void {
    this.dead = true;
    for (const q of this.queue) {
      clearTimeout(q.timer);
      q.reject(err);
    }
    this.queue = [];
    for (const p of this.inFlight.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.inFlight.clear();
  }

  get usable(): boolean {
    return !this.dead;
  }

  /**
   * `priority` defaults to 'interactive' — every pre-existing call site is
   * unaffected. Pass 'background' for work that should yield the next free
   * worker to any interactive request already waiting — for at most
   * STARVATION_PROMOTE_MS, after which it stops yielding (see this file's
   * PRIORITY doc comment above).
   */
  solve(req: DealPbn, priority: SolvePriority = 'interactive'): Promise<FutureTricks> {
    if (this.dead) return Promise.reject(new Error('dd pool is degraded'));
    const id = this.nextId++;
    return new Promise<FutureTricks>((resolve, reject) => {
      const timer = setTimeout(() => {
        const qi = this.queue.findIndex((q) => q.id === id);
        if (qi >= 0) this.queue.splice(qi, 1);
        // if it was already dispatched, drop tracking so the eventual real
        // reply is discarded as a late message (see the 'message' handler)
        this.inFlight.delete(id);
        reject(new Error(`dd pool solve exceeded ${SOLVE_TIMEOUT_MS}ms`));
      }, SOLVE_TIMEOUT_MS);
      timer.unref();
      this.queue.push({ id, req, priority: PRIORITY[priority], enqueuedAt: Date.now(), resolve, reject, timer });
      const idleIndex = this.idle.indexOf(true);
      if (idleIndex >= 0) this.dispatchNext(idleIndex);
    });
  }

  async destroy(): Promise<void> {
    this.dead = true;
    this.fail(new Error('dd pool destroyed'));
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

let shared: DdPool | null | undefined;

/**
 * The lazily created process-wide pool, or null when workers are unavailable
 * (no compiled dd-worker.js next to this module — i.e. running from src — or
 * spawn failure, or a previous pool death). First call pays the spawn cost;
 * expert-only servers and unit tests that never sample pay nothing.
 */
export function getSharedDdPool(): DdPool | null {
  if (shared !== undefined && (shared === null || shared.usable)) return shared;
  const url = new URL('./dd-worker.js', import.meta.url);
  try {
    if (url.protocol !== 'file:' || !existsSync(fileURLToPath(url))) {
      shared = null;
      return shared;
    }
    shared = new DdPool(POOL_SIZE, url);
  } catch {
    shared = null;
  }
  return shared;
}

/**
 * Tear down the shared pool if one was ever created (a no-op otherwise —
 * this never spawns). unref() keeps an idle pool from holding a process
 * open in most paths, but explicit teardown is the reliable way to let
 * long-lived processes (the server on shutdown, offline tools at the end
 * of a run) exit promptly.
 */
export async function destroySharedDdPool(): Promise<void> {
  if (shared) {
    const pool = shared;
    shared = undefined;
    await pool.destroy();
  }
}
