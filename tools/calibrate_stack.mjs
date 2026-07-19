#!/usr/bin/env node
/**
 * Combined-stack calibration: measures the FULL per-board divergence from
 * perfect play when a board is bid AND played entirely at one shipped
 * difficulty tier (all four seats), vs. the same deal bid and played
 * perfectly (pure argmax bidding + true-DD play). This is the number the
 * isolated sweeps (calibrate_stats.mjs kgrid / bidtopn) can't show on their
 * own: bidding noise can change the CONTRACT, and then card-play sampling
 * changes tricks within whatever contract was actually reached — the two
 * effects compound on the same board in real tournaments. See
 * docs/difficulty-calibration-research.md for the resulting analysis.
 *
 * Usage (from repo root, after npm run build):
 *   node tools/calibrate_stack.mjs [--seed s] [--boards n]
 */
const core = await import('../packages/core/dist/index.js');
const ai = await import('../packages/ai/dist/index.js');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const SEED = opt('seed', 'stack-1');
const BOARDS = Number(opt('boards', '200'));
const bidder = new ai.Bidder(ai.loadPolicyModel('sl'));

const TIERS = {
  beginner: { topN: 3, k: 1, aware: false },
  intermediate: { topN: 2, k: 1, aware: true },
  expert: { topN: 1, k: 8, aware: true },
};

function bidPure(deal) {
  const calls = [];
  while (!core.auctionState(deal.dealer, calls).isOver) calls.push(bidder.chooseCall(deal, calls));
  return { calls, contract: core.finalContract(deal.dealer, calls) };
}

function bidTier(deal, no, tier) {
  const calls = [];
  while (!core.auctionState(deal.dealer, calls).isOver) {
    const seed = ai.bidDecisionSeed(`${SEED}#stack`, no, calls.length);
    calls.push(bidder.chooseCall(deal, calls, { difficulty: tier, seed }));
  }
  return { calls, contract: core.finalContract(deal.dealer, calls) };
}

async function playPure(deal, contract, calls) {
  const plays = [];
  for (;;) {
    const state = core.playState(deal, contract, plays);
    if (state.isOver) return state.declarerTricks;
    plays.push(await ai.chooseCard(deal, contract, plays));
  }
}

async function playTier(deal, contract, calls, tierCfg) {
  const plays = [];
  for (;;) {
    const state = core.playState(deal, contract, plays);
    if (state.isOver) return state.declarerTricks;
    plays.push(
      await ai.chooseCardSampled(deal, contract, plays, {
        k: tierCfg.k,
        useAuction: tierCfg.aware,
        seed: ai.mcDecisionSeed(`${SEED}#stack`, 0, plays.length),
        dealer: deal.dealer,
        calls,
      }),
    );
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const stderr = (xs) => (xs.length ? stdev(xs) / Math.sqrt(xs.length) : 0);
const fmt = (x, w = 8, d = 2) => x.toFixed(d).padStart(w);
// Standard WBF/ACBL IMP scale (point diff -> IMPs).
const IMP_TABLE = [
  [10, 0], [40, 1], [80, 2], [120, 3], [160, 4], [210, 5], [260, 6], [310, 7], [360, 8],
  [420, 9], [490, 10], [590, 11], [740, 12], [890, 13], [1090, 14], [1290, 15], [1490, 16],
  [1740, 17], [1990, 18], [2240, 19], [2490, 20], [2990, 21], [3490, 22], [3990, 23],
];
function toImps(diff) {
  const d = Math.abs(diff);
  for (const [cap, imp] of IMP_TABLE) if (d <= cap) return imp;
  return 24;
}

console.error(`preparing ${BOARDS} boards...`);
const deals = [];
for (let no = 1; deals.length < BOARDS; no++) {
  const deal = core.dealBoard(SEED, no);
  const { calls, contract } = bidPure(deal);
  if (!contract) continue;
  const refTricks = await playPure(deal, contract, calls);
  deals.push({ no, deal, calls, contract, refTricks });
  if (deals.length % 25 === 0) console.error(`  ${deals.length}/${BOARDS}`);
}
console.error(`ready: ${deals.length} contract boards.\n`);

console.log(`\n=== Combined stack: full board (bid+play) at each shipped tier vs. pure/true-DD reference, ${deals.length} boards ===`);
console.log(`tier         | contract-changed% | ΔNS mean±SE        | ΔNS median | mean IMP-equiv | %boards >=1 IMP`);
for (const [name, cfg] of Object.entries(TIERS)) {
  const deltas = [];
  let changed = 0;
  for (const b of deals) {
    const { calls: tCalls, contract: tContract } = bidTier(b.deal, b.no, name);
    let tricks = 0;
    let score = 0;
    if (tContract) {
      tricks = await playTier(b.deal, tContract, tCalls, cfg);
      score = core.boardScoreNS(tContract, b.deal.vul, tricks);
    }
    if (JSON.stringify(tContract) !== JSON.stringify(b.contract)) changed++;
    const refScore = core.boardScoreNS(b.contract, b.deal.vul, b.refTricks);
    deltas.push(Math.abs(score - refScore));
  }
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const imps = deltas.map(toImps);
  const pctAtLeast1Imp = (100 * imps.filter((i) => i >= 1).length) / imps.length;
  console.log(
    `${name.padEnd(12)} |${fmt((100 * changed) / deals.length, 18, 1)} |${fmt(mean(deltas), 8)}±${fmt(
      stderr(deltas), 6, 2,
    )}    |${fmt(median, 11)} |${fmt(mean(imps), 14, 2)} |${fmt(pctAtLeast1Imp, 15, 1)}`,
  );
}
await ai.destroySharedDdPool();
