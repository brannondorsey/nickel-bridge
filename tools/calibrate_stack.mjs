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
 *   node tools/calibrate_stack.mjs [--seed s] [--boards n] [--ew-only]
 *
 * Default mode weakens ALL FOUR seats to the tier's config and reports
 * unsigned |ΔNS| — a "how far from a perfect board does this tier typically
 * land" measurement, useful as a sanity check that degraded tables don't
 * produce wildly incoherent boards, but NOT a direct measurement of what the
 * app's difficulty tiers do to a human's experience: production never
 * weakens North (PARTNER_FLOOR always pins the human's partner at
 * expert-opponent strength — see difficulty.ts), so a metric that also
 * randomly degrades N (and S, standing in for the human) mixes in noise from
 * a seat the real game never touches, and unsigned deltas can't distinguish
 * "the tier helped NS" from "the tier hurt NS" — both inflate the mean.
 *
 * --ew-only instead weakens ONLY East/West (the opponents) — mirroring
 * PARTNER_FLOOR's asymmetry exactly — and reports SIGNED IMP swing (positive
 * = NS, i.e. the human's side, gained IMPs because the opponents got
 * weaker). This is the more direct instrument for "how much easier does this
 * tier make the game," and is what surfaced the beginner/intermediate gap
 * discussed in docs/difficulty-calibration-research.md's addendum.
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
const EW_ONLY = args.includes('--ew-only');
const bidder = new ai.Bidder(ai.loadPolicyModel('sl'));
const isEW = (seat) => seat === 1 || seat === 3;

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

/** EW_ONLY: North/South always bid pure; only East/West get the tier's noise. */
function bidTier(deal, no, tier) {
  const calls = [];
  for (;;) {
    const state = core.auctionState(deal.dealer, calls);
    if (state.isOver) break;
    const opts =
      !EW_ONLY || isEW(state.turn) ? { difficulty: tier, seed: ai.bidDecisionSeed(`${SEED}#stack`, no, calls.length) } : undefined;
    calls.push(bidder.chooseCall(deal, calls, opts));
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

/** EW_ONLY: North/South always play true-DD; only East/West get the tier's sampled play. */
async function playTier(deal, contract, calls, tierCfg) {
  const plays = [];
  for (;;) {
    const state = core.playState(deal, contract, plays);
    if (state.isOver) return state.declarerTricks;
    if (EW_ONLY) {
      const dummy = core.partnerOf(contract.declarer);
      const actor = state.handToPlay === dummy ? contract.declarer : state.handToPlay;
      if (!isEW(actor)) {
        plays.push(await ai.chooseCard(deal, contract, plays));
        continue;
      }
    }
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
/** Signed IMP-equivalent: positive = NS gained relative to the reference. */
function toImpsSigned(diff) {
  const imp = toImps(diff);
  return diff < 0 ? -imp : imp;
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

console.log(
  `\n=== Combined stack: full board (bid+play) at each shipped tier vs. pure/true-DD reference, ${deals.length} boards${
    EW_ONLY ? ' [EW-ONLY: N/S pinned true-DD, signed IMPs — matches PARTNER_FLOOR]' : ' [all four seats weakened, unsigned]'
  } ===`,
);
if (EW_ONLY) {
  console.log(`tier         | contract-changed% | signed IMP mean±SE  | IMP median | %boards |imp|>=1`);
} else {
  console.log(`tier         | contract-changed% | ΔNS mean±SE        | ΔNS median | mean IMP-equiv | %boards >=1 IMP`);
}
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
    deltas.push(EW_ONLY ? score - refScore : Math.abs(score - refScore));
  }
  if (EW_ONLY) {
    const imps = deltas.map(toImpsSigned);
    const sorted = [...imps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const pctAtLeast1Imp = (100 * imps.filter((i) => Math.abs(i) >= 1).length) / imps.length;
    console.log(
      `${name.padEnd(12)} |${fmt((100 * changed) / deals.length, 18, 1)} |${fmt(mean(imps), 12, 2)}±${fmt(
        stderr(imps), 6, 2,
      )} |${fmt(median, 11)} |${fmt(pctAtLeast1Imp, 15, 1)}`,
    );
  } else {
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
}
await ai.destroySharedDdPool();
