#!/usr/bin/env node
/**
 * Compare named CANDIDATE difficulty configs — not just the shipped tiers —
 * against the same prepared board set, EW-only + signed IMP (matches
 * calibrate_stack.mjs --ew-only's methodology: North/South always bid/play
 * pure double-dummy throughout, only East/West vary, matching PARTNER_FLOOR's
 * asymmetry). This is the tool for "should we nerf X further or harden Y
 * instead" questions — edit the CONFIGS array below, rerun, compare.
 *
 * Mutates ai.MC_SAMPLES/BID_NOISE/PLAY_NOISE.intermediate as a scratch
 * "vehicle" slot per candidate config (same trick calibrate_k.mjs and
 * calibrate_stats.mjs use for their sweeps) — never touches the 'beginner' or
 * 'expert' slots, so a candidate row can never corrupt a real tier's
 * behavior mid-run. Each row sets the vehicle, measures every board, moves
 * on to the next row. See docs/difficulty-tuning-guide.md for the full
 * methodology writeup and a worked example of using this tool.
 *
 * Usage (from repo root, after npm run build):
 *   node tools/calibrate_whatif.mjs [--seed s] [--boards n]
 *
 * Edit CONFIGS below to add/remove candidates. A row with a null second
 * element is printed as a section header (for grouping candidates by which
 * question they answer) rather than measured.
 */
const core = await import('../packages/core/dist/index.js');
const ai = await import('../packages/ai/dist/index.js');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const SEED = opt('seed', 'whatif-1');
const BOARDS = Number(opt('boards', '200'));
const bidder = new ai.Bidder(ai.loadPolicyModel('sl'));
const isEW = (seat) => seat === 1 || seat === 3;
const VEHICLE = 'intermediate'; // scratch slot; never 'beginner' or 'expert'

// Standard WBF/ACBL IMP scale (point diff -> IMPs).
const IMP_TABLE = [
  [10, 0], [40, 1], [80, 2], [120, 3], [160, 4], [210, 5], [260, 6], [310, 7], [360, 8],
  [420, 9], [490, 10], [590, 11], [740, 12], [890, 13], [1090, 14], [1290, 15], [1490, 16],
  [1740, 17], [1990, 18], [2240, 19], [2490, 20], [2990, 21], [3490, 22], [3990, 23],
];
/** Signed IMP-equivalent: positive = NS (the human's side) gained relative to the reference. */
function toImpsSigned(diff) {
  const d = Math.abs(diff);
  let imp = 24;
  for (const [cap, v] of IMP_TABLE) if (d <= cap) { imp = v; break; }
  return diff < 0 ? -imp : imp;
}

function bidPure(deal) {
  const calls = [];
  while (!core.auctionState(deal.dealer, calls).isOver) calls.push(bidder.chooseCall(deal, calls));
  return { calls, contract: core.finalContract(deal.dealer, calls) };
}
async function playPure(deal, contract) {
  const plays = [];
  for (;;) {
    const state = core.playState(deal, contract, plays);
    if (state.isOver) return state.declarerTricks;
    plays.push(await ai.chooseCard(deal, contract, plays));
  }
}

/** EW-only: N/S stay pure/true-DD; EW bids/plays at the vehicle's current config. */
function bidTier(deal, no) {
  const calls = [];
  for (;;) {
    const state = core.auctionState(deal.dealer, calls);
    if (state.isOver) break;
    const opts = isEW(state.turn) ? { difficulty: VEHICLE, seed: ai.bidDecisionSeed(`${SEED}#stack`, no, calls.length) } : undefined;
    calls.push(bidder.chooseCall(deal, calls, opts));
  }
  return { calls, contract: core.finalContract(deal.dealer, calls) };
}
async function playTier(deal, contract, calls) {
  const plays = [];
  const mc = ai.MC_SAMPLES[VEHICLE];
  for (;;) {
    const state = core.playState(deal, contract, plays);
    if (state.isOver) return state.declarerTricks;
    const dummy = core.partnerOf(contract.declarer);
    const actor = state.handToPlay === dummy ? contract.declarer : state.handToPlay;
    if (!isEW(actor)) {
      plays.push(await ai.chooseCard(deal, contract, plays));
      continue;
    }
    plays.push(
      await ai.chooseCardSampled(deal, contract, plays, {
        k: mc.kOpp,
        useAuction: mc.auctionAware,
        playTopN: ai.PLAY_NOISE[VEHICLE].topN,
        seed: ai.mcDecisionSeed(`${SEED}#stack`, 0, plays.length),
        dealer: deal.dealer,
        calls,
      }),
    );
  }
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stdev = (xs) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const stderr = (xs) => stdev(xs) / Math.sqrt(xs.length);
const fmt = (x, w = 7, d = 2) => x.toFixed(d).padStart(w);

console.error(`preparing ${BOARDS} boards...`);
const deals = [];
for (let no = 1; deals.length < BOARDS; no++) {
  const deal = core.dealBoard(SEED, no);
  const { calls, contract } = bidPure(deal);
  if (!contract) continue;
  const refTricks = await playPure(deal, contract);
  deals.push({ no, deal, calls, contract, refTricks });
  if (deals.length % 25 === 0) console.error(`  ${deals.length}/${BOARDS}`);
}
console.error(`ready: ${deals.length} contract boards.\n`);

// [label, kOpp, auctionAware, bidTopN, playTopN] — edit freely; a row with a
// null second element prints as a section header instead of being measured.
const CONFIGS = [
  ['beginner (shipped)', 1, false, 3, 3],
  ['intermediate (shipped)', 1, true, 2, 1],
  ['expert (shipped)', 8, true, 1, 1],
  ['— add candidate configs below, grouped by the question they answer —', null],
];

console.log(`\n${deals.length} boards, seed '${SEED}' — EW-only signed IMP vs pure/true-DD reference\n`);
console.log(`config                                              | contract-changed% | signed IMP mean±SE`);
for (const row of CONFIGS) {
  if (row[1] === null) {
    console.log(`\n${row[0]}`);
    continue;
  }
  const [label, kOpp, auctionAware, bidTopN, playTopN] = row;
  ai.MC_SAMPLES[VEHICLE].kOpp = kOpp;
  ai.MC_SAMPLES[VEHICLE].auctionAware = auctionAware;
  ai.BID_NOISE[VEHICLE].topN = bidTopN;
  ai.PLAY_NOISE[VEHICLE].topN = playTopN;

  const imps = [];
  let changed = 0;
  for (const d of deals) {
    const { calls: tCalls, contract: tContract } = bidTier(d.deal, d.no);
    let score = 0;
    if (tContract) {
      const tricks = await playTier(d.deal, tContract, tCalls);
      score = core.boardScoreNS(tContract, d.deal.vul, tricks);
    }
    if (JSON.stringify(tContract) !== JSON.stringify(d.contract)) changed++;
    const refScore = core.boardScoreNS(d.contract, d.deal.vul, d.refTricks);
    imps.push(toImpsSigned(score - refScore));
  }
  console.log(
    `${label.padEnd(52)} |${fmt((100 * changed) / deals.length, 18, 1)} |${fmt(mean(imps), 10)}±${fmt(stderr(imps), 5)}`,
  );
}

await ai.destroySharedDdPool();
