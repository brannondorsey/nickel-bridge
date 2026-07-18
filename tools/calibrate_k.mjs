#!/usr/bin/env node
/**
 * Calibrate the sampled-DD difficulty dial (K) against true double-dummy play.
 *
 * For each board: the robots bid the auction (sl model, SAYC-guardrailed),
 * then the play runs three ways — all-true-DD (the reference), sampled
 * DEFENSE vs true-DD declarer, and sampled DECLARER vs true-DD defense — for
 * every K in the grid. The report shows, per K:
 *   - tricks conceded per board by sampled defense / sampled declarer
 *     (mean and max vs the DD reference result),
 *   - the mean |NS score delta| those tricks translate to (the human-facing
 *     "points a tier gives away per board"),
 *   - wall-time per sampled decision bucketed by trick number (trick 1 is the
 *     expensive one — K near-full-deal solves),
 *   - a partner check: defense rerun at max(K, PARTNER_FLOOR).
 *
 * The owner uses this table to set MC_SAMPLES/PARTNER_FLOOR in
 * packages/ai/src/difficulty.ts. NOTE: changing those constants changes robot
 * behavior on future boards of in-flight non-expert tournaments (an
 * invariant-1 comparability break for those tournaments); calibrate before
 * promoting non-expert play, or accept the beta caveat.
 *
 * Usage (from repo root, after npm run build):
 *   node tools/calibrate_k.mjs [--seed cal-1] [--boards 40] [--k 4,8,16,32,64] [--json out.json] [--blind]
 *
 * --blind runs sampled actors with useAuction: false (no SAYC constraints on
 * hidden hands, voids only) — the beginner tier's auction-blind configuration.
 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const core = await import('../packages/core/dist/index.js');
const ai = await import('../packages/ai/dist/index.js');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const SEED = opt('seed', 'cal-1');
const BOARDS = Number(opt('boards', '40'));
const K_GRID = opt('k', '4,8,16,32,64').split(',').map(Number);
const JSON_OUT = opt('json', null);
const BLIND = args.includes('--blind');

const bidder = new ai.Bidder(ai.loadPolicyModel('sl'));

/** Bid the auction with robots in all four seats. Returns null on a pass-out. */
function bidAuction(deal) {
  const calls = [];
  while (!core.auctionState(deal.dealer, calls).isOver) {
    calls.push(bidder.chooseCall(deal, calls));
  }
  return { calls, contract: core.finalContract(deal.dealer, calls) };
}

/**
 * Play a board to the end. `sampledSide` is 'declarer', 'defense', or null
 * (all true-DD); sampled actors use chooseCardSampled at the given k with the
 * standard seed convention. Returns declarer tricks and per-decision timings.
 */
async function playOut(deal, contract, calls, sampledSide, k, timings) {
  const plays = [];
  for (;;) {
    const state = core.playState(deal, contract, plays);
    if (state.isOver) return state.declarerTricks;
    const dummy = core.partnerOf(contract.declarer);
    const actor = state.handToPlay === dummy ? contract.declarer : state.handToPlay;
    const actorDeclares = actor % 2 === contract.declarer % 2;
    const sampled =
      sampledSide !== null && (sampledSide === 'declarer' ? actorDeclares : !actorDeclares);
    if (!sampled) {
      plays.push(await ai.chooseCard(deal, contract, plays));
      continue;
    }
    const t0 = performance.now();
    plays.push(
      await ai.chooseCardSampled(deal, contract, plays, {
        k,
        useAuction: !BLIND,
        seed: ai.mcDecisionSeed(`${SEED}#cal`, 0, plays.length),
        dealer: deal.dealer,
        calls,
      }),
    );
    if (timings) timings.push({ trick: Math.floor(plays.length / 4) + 1, ms: performance.now() - t0 });
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (x, w = 6) => x.toFixed(2).padStart(w);

// ---- collect boards: deal + auction + true-DD reference ------------------
const boards = [];
for (let no = 1; boards.length < BOARDS; no++) {
  const deal = core.dealBoard(SEED, no);
  const { calls, contract } = bidAuction(deal);
  if (!contract) continue; // pass-out: nothing to play
  const refTricks = await playOut(deal, contract, calls, null, 0, null);
  boards.push({ no, deal, calls, contract, refTricks });
  if (boards.length % 10 === 0) console.error(`prepared ${boards.length}/${BOARDS} boards`);
}

// ---- sweep the K grid ----------------------------------------------------
const results = [];
const partnerFloor = ai.PARTNER_FLOOR;
for (const k of K_GRID) {
  const defConceded = []; // tricks the sampled DEFENSE gives up vs reference
  const declConceded = []; // tricks the sampled DECLARER gives up vs reference
  const scoreDelta = []; // |NS score change| from the defense run (human declaring is the common pain case)
  const partnerConceded = []; // defense rerun at max(k, PARTNER_FLOOR)
  const timings = [];
  for (const b of boards) {
    const defTricks = await playOut(b.deal, b.contract, b.calls, 'defense', k, timings);
    const declTricks = await playOut(b.deal, b.contract, b.calls, 'declarer', k, null);
    defConceded.push(defTricks - b.refTricks);
    declConceded.push(b.refTricks - declTricks);
    scoreDelta.push(
      Math.abs(
        core.boardScoreNS(b.contract, b.deal.vul, defTricks) -
          core.boardScoreNS(b.contract, b.deal.vul, b.refTricks),
      ),
    );
    const pk = Math.max(k, partnerFloor);
    partnerConceded.push(
      pk === k ? defTricks - b.refTricks : (await playOut(b.deal, b.contract, b.calls, 'defense', pk, null)) - b.refTricks,
    );
  }
  const byTrick = new Map();
  for (const t of timings) {
    if (!byTrick.has(t.trick)) byTrick.set(t.trick, []);
    byTrick.get(t.trick).push(t.ms);
  }
  results.push({
    k,
    defMean: mean(defConceded),
    defMax: Math.max(...defConceded),
    declMean: mean(declConceded),
    declMax: Math.max(...declConceded),
    scoreDeltaMean: mean(scoreDelta),
    partnerMean: mean(partnerConceded),
    msMeanTrick1: mean(byTrick.get(1) ?? []),
    msMeanAll: mean(timings.map((t) => t.ms)),
    msMax: timings.length ? Math.max(...timings.map((t) => t.ms)) : 0,
  });
  console.error(`swept K=${k}`);
}

// ---- report --------------------------------------------------------------
console.log(
  `\n${boards.length} boards, seed '${SEED}'${BLIND ? ' [BLIND: no auction constraints]' : ''} — tricks conceded per board vs true-DD reference`,
);
console.log(`(defense = sampled robots defending a DD declarer; declarer = sampled robot declaring vs DD defense)`);
console.log(
  `\n   K | def mean  def max | decl mean  decl max | |ΔNS score| | partner(≥${partnerFloor}) | ms/decision t1 / all / max`,
);
for (const r of results) {
  console.log(
    `${String(r.k).padStart(4)} |${fmt(r.defMean, 9)}${fmt(r.defMax, 9)} |${fmt(r.declMean, 10)}${fmt(
      r.declMax,
      10,
    )} |${fmt(r.scoreDeltaMean, 11)} |${fmt(r.partnerMean, 13)} |${fmt(r.msMeanTrick1, 8)} /${fmt(
      r.msMeanAll,
      7,
    )} /${fmt(r.msMax, 8)}`,
  );
}
console.log(
  `\nreading the table: pick K where "def mean" lands at the target skill —` +
    `\n  ~1.5+ tricks ≈ beginner-friendly, ~0.5–1 ≈ decent club player, → 0 ≈ expert.` +
    `\nEdit MC_SAMPLES/PARTNER_FLOOR in packages/ai/src/difficulty.ts accordingly.`,
);

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ seed: SEED, boards: boards.length, results }, null, 2));
  console.error(`wrote ${JSON_OUT}`);
}
// The sampled solves spun up the shared worker pool; tear it down so the
// process exits (unref alone does not release the loop while the worker
// message ports are live).
await ai.destroySharedDdPool();
