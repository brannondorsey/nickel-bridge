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
 *   node tools/calibrate_k.mjs [--seed cal-1] [--boards 40] --bid-topn 2,3,4,6
 *
 * --blind runs sampled actors with useAuction: false (no SAYC constraints on
 * hidden hands, voids only) — the beginner tier's auction-blind configuration.
 *
 * --bid-topn runs a SEPARATE sweep of the bidding-noise dial (BID_NOISE in
 * packages/ai/src/difficulty.ts): for each topN, every board's auction is bid
 * twice — once with the pure constrained argmax (today's difficulty-blind
 * behavior), once with noisy sampling at that topN — and both auctions are
 * played out true-DD on both sides, isolating bidding noise's own scoring
 * impact from card-play sampling. Independent of --k/--blind; skipped by
 * default (bidding calibration is a separate concern from the K grid).
 *
 * --forget-window is a THIRD, separate sweep: a prototype measurement of the
 * card-"forgetting" idea (packages/ai/src/play-mc-forget.ts, EXPERIMENTAL and
 * NOT wired into any shipped tier). For each window value, sampled defense at
 * --forget-k (default 1) uses a memory-limited view of shown-out voids
 * (tricks older than the window are forgotten) instead of the complete public
 * record, and its tricks-conceded is compared against an unwindowed baseline
 * at the same K — isolating whatever memory decay adds beyond K-sampling
 * alone. Purely a measurement to inform whether it's worth wiring into
 * difficulty.ts for real; this tool never touches BID_NOISE/MC_SAMPLES for
 * --forget-window (only --bid-topn mutates BID_NOISE, and only for its own
 * sweep).
 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const core = await import('../packages/core/dist/index.js');
const ai = await import('../packages/ai/dist/index.js');
const forget = await import('../packages/ai/dist/play-mc-forget.js');

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
const BID_TOPN_GRID = opt('bid-topn', null);
const FORGET_WINDOW_GRID = opt('forget-window', null);
const FORGET_K = Number(opt('forget-k', '1'));

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

/** Like playOut, but the sampled side uses chooseCardSampledForgetful (windowed void-memory). */
async function playOutForgetful(deal, contract, calls, sampledSide, k, memoryWindow) {
  const plays = [];
  for (;;) {
    const state = core.playState(deal, contract, plays);
    if (state.isOver) return state.declarerTricks;
    const dummy = core.partnerOf(contract.declarer);
    const actor = state.handToPlay === dummy ? contract.declarer : state.handToPlay;
    const actorDeclares = actor % 2 === contract.declarer % 2;
    const sampled = sampledSide !== null && (sampledSide === 'declarer' ? actorDeclares : !actorDeclares);
    if (!sampled) {
      plays.push(await ai.chooseCard(deal, contract, plays));
      continue;
    }
    plays.push(
      await forget.chooseCardSampledForgetful(deal, contract, plays, {
        k,
        useAuction: !BLIND,
        seed: ai.mcDecisionSeed(`${SEED}#cal-forget`, 0, plays.length),
        dealer: deal.dealer,
        calls,
        memoryWindow,
      }),
    );
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

// ---- optional bidding-noise sweep (separate axis from K) ------------------
if (BID_TOPN_GRID) {
  const topns = BID_TOPN_GRID.split(',').map(Number);
  console.log(
    `\n${boards.length} boards — bidding-noise sweep over topN ${topns.join(',')}: pure argmax vs noisy` +
      ` auction, both played out true-DD on both sides (isolates bidding noise from card-play sampling)`,
  );
  console.log(`  topN | contract changed % | deviations/auction | |ΔNS score| mean / max`);
  for (const topN of topns) {
    // BID_NOISE is a plain exported object; 'beginner' is just the sweep
    // vehicle here — mutated per candidate topN, matching the existing
    // "hand-edit after reading the table" calibration workflow.
    ai.BID_NOISE.beginner.topN = topN;
    let changed = 0;
    let totalDeviations = 0;
    const scoreDeltas = [];
    for (const b of boards) {
      const noisyCalls = [];
      let deviations = 0;
      while (!core.auctionState(b.deal.dealer, noisyCalls).isOver) {
        const seed = ai.bidDecisionSeed(`${SEED}#bidcal`, b.no, noisyCalls.length);
        const pure = bidder.chooseCall(b.deal, noisyCalls);
        const noisy = bidder.chooseCall(b.deal, noisyCalls, { difficulty: 'beginner', seed });
        if (noisy !== pure) deviations++;
        noisyCalls.push(noisy);
      }
      totalDeviations += deviations;
      const noisyContract = core.finalContract(b.deal.dealer, noisyCalls);
      if (JSON.stringify(noisyContract) !== JSON.stringify(b.contract)) changed++;
      const noisyTricks = noisyContract ? await playOut(b.deal, noisyContract, noisyCalls, null, 0, null) : null;
      const noisyScore = noisyContract ? core.boardScoreNS(noisyContract, b.deal.vul, noisyTricks) : 0;
      const pureScore = core.boardScoreNS(b.contract, b.deal.vul, b.refTricks);
      scoreDeltas.push(Math.abs(noisyScore - pureScore));
    }
    console.log(
      `${String(topN).padStart(5)} |${fmt((100 * changed) / boards.length, 19)} |${fmt(
        totalDeviations / boards.length,
        20,
      )} |${fmt(mean(scoreDeltas), 12)} / ${fmt(Math.max(...scoreDeltas), 6)}`,
    );
  }
  console.log(
    `\nreading the table: pick topN where |ΔNS score| lands at the target skill drop for beginner/intermediate.` +
      `\nEdit BID_NOISE in packages/ai/src/difficulty.ts accordingly.`,
  );
}

// ---- optional card-"forgetting" prototype sweep (experimental, unshipped) -
if (FORGET_WINDOW_GRID) {
  const windows = FORGET_WINDOW_GRID.split(',').map(Number);
  const baselineConceded = [];
  for (const b of boards) {
    const defTricks = await playOut(b.deal, b.contract, b.calls, 'defense', FORGET_K, null);
    baselineConceded.push(defTricks - b.refTricks);
  }
  console.log(
    `\n${boards.length} boards — card-memory ("forgetting") PROTOTYPE sweep at K=${FORGET_K}` +
      ` (packages/ai/src/play-mc-forget.ts, not wired into any shipped tier)`,
  );
  console.log(
    `baseline (no forgetting, today's mechanism): def mean ${mean(baselineConceded).toFixed(2)}` +
      `  def max ${Math.max(...baselineConceded)}`,
  );
  console.log(`  window | def mean  def max | |ΔNS score| mean`);
  for (const w of windows) {
    const conceded = [];
    const scoreDeltas = [];
    for (const b of boards) {
      const defTricks = await playOutForgetful(b.deal, b.contract, b.calls, 'defense', FORGET_K, w);
      conceded.push(defTricks - b.refTricks);
      scoreDeltas.push(
        Math.abs(
          core.boardScoreNS(b.contract, b.deal.vul, defTricks) -
            core.boardScoreNS(b.contract, b.deal.vul, b.refTricks),
        ),
      );
    }
    console.log(`${String(w).padStart(6)} |${fmt(mean(conceded), 9)}${fmt(Math.max(...conceded), 9)} |${fmt(mean(scoreDeltas), 15)}`);
  }
  console.log(
    `\nreading the table: compare each window's "def mean" against the no-forgetting baseline above — a` +
      ` gap confirms memory decay adds a concession beyond K-sampling alone. This is a measurement only;` +
      ` wiring it into a shipped tier is a separate, deliberate decision (see CONTRIBUTING.md).`,
  );
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ seed: SEED, boards: boards.length, results }, null, 2));
  console.error(`wrote ${JSON_OUT}`);
}
// The sampled solves spun up the shared worker pool; tear it down so the
// process exits (unref alone does not release the loop while the worker
// message ports are live).
await ai.destroySharedDdPool();
