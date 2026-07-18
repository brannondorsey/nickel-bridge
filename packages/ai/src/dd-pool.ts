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

interface Pending {
  resolve: (res: FutureTricks) => void;
  reject: (err: Error) => void;
  workerIndex: number;
  timer: NodeJS.Timeout;
}

export class DdPool {
  private workers: Worker[] = [];
  private busy: number[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private dead = false;

  constructor(size: number, workerUrl: URL) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerUrl);
      worker.unref();
      worker.on('message', (msg: { id: number; res?: FutureTricks; error?: string }) => {
        const p = this.pending.get(msg.id);
        if (!p) return; // timed out earlier — late reply discarded
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        this.busy[p.workerIndex]--;
        if (msg.error !== undefined) p.reject(new Error(msg.error));
        else p.resolve(msg.res!);
      });
      worker.on('error', (err: unknown) => this.fail(err instanceof Error ? err : new Error(String(err))));
      worker.on('exit', (code) => {
        // ANY exit while requests are in flight loses their replies — fail so
        // callers fall back, whatever the exit code claims.
        if (!this.dead && (code !== 0 || this.pending.size > 0)) {
          this.fail(new Error(`dd-worker exited with code ${code}`));
        }
      });
      this.workers.push(worker);
      this.busy.push(0);
    }
  }

  /** reject everything in flight and mark the pool unusable (callers fall back) */
  private fail(err: Error): void {
    this.dead = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  get usable(): boolean {
    return !this.dead;
  }

  solve(req: DealPbn): Promise<FutureTricks> {
    if (this.dead) return Promise.reject(new Error('dd pool is degraded'));
    let workerIndex = 0;
    for (let i = 1; i < this.workers.length; i++) {
      if (this.busy[i] < this.busy[workerIndex]) workerIndex = i;
    }
    const id = this.nextId++;
    this.busy[workerIndex]++;
    return new Promise<FutureTricks>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        this.busy[p.workerIndex]--;
        p.reject(new Error(`dd pool solve exceeded ${SOLVE_TIMEOUT_MS}ms`));
      }, SOLVE_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, workerIndex, timer });
      this.workers[workerIndex].postMessage({ id, req });
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
