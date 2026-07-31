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
import type { DealPbn, FutureTricks } from '../vendor/bridge-dds/api.js';
import { SolvePriority, getSharedDdPool } from './dd-pool.js';

let ddsInstance: Dds | null = null;

async function getDds(): Promise<Dds> {
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

/** Per-legal-card DD scores for the current position, plus the best score. */
export interface DdSolve {
  /** tricks the side to move gets if this card is led/played, with optimal play thereafter */
  cardScores: Map<Card, number>;
  /** max tricks the side to move can force, regardless of the opponents' defense */
  bestScore: number;
}

/**
 * The DDS SolveBoardPBN input for a position — pure construction, no WASM.
 * Split out from solveFutureTricks so the same request can be solved on the
 * main thread or shipped to a worker (plain strings/numbers both ways).
 */
export function buildSolveRequest(deal: Deal, contract: Contract, plays: Card[]): DealPbn {
  const state = playState(deal, contract, plays);
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

  return {
    trump: ddsTrump(contract.strain),
    first: leader,
    currentTrickSuit,
    currentTrickRank,
    remainCards: pbn,
  };
}

/**
 * FutureTricks → DdSolve. FutureTricks.score[i] = tricks the side to move can
 * take if card i is led/played; `equals` is a bitmask of lower equivalent
 * cards subsumed by entry i. Pure, so worker replies can be parsed anywhere.
 */
export function futureTricksToDdSolve(res: FutureTricks): DdSolve {
  let bestScore = -1;
  const cardScores = new Map<Card, number>();
  for (let i = 0; i < res.cards; i++) {
    const suit = res.suit[i] as 0 | 1 | 2 | 3;
    const cards = [res.rank[i], ...maskToRanks(res.equals[i])].map((r) => suit * 13 + (r - 2));
    for (const card of cards) cardScores.set(card, res.score[i]);
    if (res.score[i] > bestScore) bestScore = res.score[i];
  }
  return { cardScores, bestScore };
}

/**
 * Solve an arbitrary prebuilt request on the shared main-thread DDS instance.
 *
 * This BLOCKS THE EVENT LOOP for the whole solve: SolveBoardPBN is one
 * synchronous WASM call with no yield point (the vendored build has neither
 * Asyncify nor JSPI), so nothing else — no timer, no I/O callback, no other
 * request — runs until it returns. Measured over 240 trick-0 full-board
 * solves on one core: p50 47ms, p90 257ms, p99 763ms, max 1.58s. Prefer
 * solveVia, which reaches this only when there is no worker pool to use.
 */
export async function solveRequest(req: DealPbn): Promise<FutureTricks> {
  const dds = await getDds();
  return dds.SolveBoardPBN(
    req,
    -1, // target: find the maximum
    3, // solutions: score all legal cards
    0,
  );
}

/** The only part of DdPool solveVia needs, so a test can stand in for one. */
export interface SolveSource {
  solve(req: DealPbn, priority: SolvePriority): Promise<FutureTricks>;
}

/**
 * Solve one request, on a worker whenever that is possible at all — the one
 * place that decides pool-vs-main-thread, for every DD solve in the app
 * (solveFutureTricks here, chooseCardSampled in play-mc.ts, the unshipped
 * play-mc-forget.ts). Three copies of this used to reach for the main thread
 * the moment a pool call rejected, which is backwards: a slow solve on a
 * worker costs one request some latency, while the same solve on the main
 * thread costs EVERY concurrent request the whole of it (see solveRequest).
 *
 * The case that actually reached it is a pool dying MID-FLIGHT. A pool that
 * is already dead never gets handed out — getSharedDdPool() replaces it on
 * lookup — but a worker erroring or exiting during a decision rejects every
 * outstanding solve at once, and callers arrive here in bulk
 * (chooseCardSampled solves K layouts under one Promise.all). So one worker
 * crash became K sequential main-thread solves with nothing able to
 * interleave. Measured on one core, K=8 with the pool killed mid-decision:
 * the event loop fired 3 timer ticks in 903ms, worst lag 510ms; through
 * here it fires 67, worst lag 3.9ms, and the decision finishes SOONER
 * (678ms) because the solves keep their own thread.
 *
 * Hence the retry: a rejection whose next lookup yields a DIFFERENT pool
 * means the old one died and the replacement answers in milliseconds. A
 * rejection from a pool that is still usable is a timeout instead, and
 * re-queueing that would land behind the same backlog — so it falls
 * through. Since SOLVE_TIMEOUT_MS is ~10x the slowest solve measured above,
 * a timeout means the pool is wedged rather than the deal being hard, and
 * the main thread really is the only way left to answer.
 *
 * Never changes a result, only where it is computed — DDS is deterministic,
 * so invariant 1 is untouched (same argument as the pool itself).
 */
export async function solveVia(
  req: DealPbn,
  priority: SolvePriority = 'interactive',
  /** overridable only so tests can drive this policy without a built worker */
  getPool: () => SolveSource | null = getSharedDdPool,
): Promise<FutureTricks> {
  const pool = getPool();
  if (pool) {
    try {
      return await pool.solve(req, priority);
    } catch {
      const fresh = getPool();
      if (fresh && fresh !== pool) {
        try {
          return await fresh.solve(req, priority);
        } catch {
          // the replacement died too — the main thread is all that is left
        }
      }
    }
  }
  return solveRequest(req);
}

/**
 * Runs the double-dummy solver once for the current position and scores
 * every legal card. `bestScore` answers the laydown question for *both*
 * sides at once: if it equals the tricks remaining, the side to move can
 * force every remaining trick (a laydown for them); if it's 0, the side to
 * move can force nothing, which — by the same DD guarantee — means the
 * *other* side can force everything (a laydown for the defense).
 *
 * Runs through solveVia, so this is a worker solve whenever a pool exists —
 * see that function for why the main-thread path is a last resort. DDS is
 * deterministic, so where the solve runs can never change its result —
 * latency only, invariant 1 untouched.
 *
 * `priority` defaults to 'interactive' (every existing call site — a real
 * human decision point) and forwards to the pool's dispatch queue; see
 * dd-pool.ts's doc comment for why this exists.
 */
export async function solveFutureTricks(
  deal: Deal,
  contract: Contract,
  plays: Card[],
  priority: SolvePriority = 'interactive',
): Promise<DdSolve> {
  return futureTricksToDdSolve(await solveVia(buildSolveRequest(deal, contract, plays), priority));
}

/**
 * Deterministic tie-break among DD-optimal cards: lowest rank, then suit —
 * robots always produce the same play on the same deal, which keeps
 * duplicate comparison across players fair.
 */
export function pickFromSolve(legal: Card[], solve: DdSolve): Card {
  const best = legal
    .filter((c) => (solve.cardScores.get(c) ?? -1) === solve.bestScore)
    .sort((a, b) => cardRank(a) - cardRank(b) || cardSuit(a) - cardSuit(b));
  if (best.length === 0) {
    // defensive: DDS disagreed about legality — never happens, but never stall a game
    return legal.sort((a, b) => cardRank(a) - cardRank(b) || cardSuit(a) - cardSuit(b))[0];
  }
  return best[0];
}

/** Choose the double-dummy-optimal card for the hand to play. */
export async function chooseCard(
  deal: Deal,
  contract: Contract,
  plays: Card[],
  priority: SolvePriority = 'interactive',
): Promise<Card> {
  const state = playState(deal, contract, plays);
  const legal = legalCards(deal, state);
  if (legal.length === 0) throw new Error('no legal cards');
  if (legal.length === 1) return legal[0];
  return pickFromSolve(legal, await solveFutureTricks(deal, contract, plays, priority));
}

/** DDS `equals` bitmask (bit r set = rank r is equivalent) → ranks */
function maskToRanks(mask: number): number[] {
  const ranks: number[] = [];
  for (let r = 2; r <= 14; r++) if (mask & (1 << r)) ranks.push(r);
  return ranks;
}
