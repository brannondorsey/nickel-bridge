#!/usr/bin/env node
/**
 * Companion to calibrate_k.mjs: the same sweeps (K-grid, bidding-noise topN,
 * card-forgetting window), but reporting standard error and a few extra
 * metrics (percent of boards with any concession, made/down flip rate,
 * contract/level-changed rate) so the calibration tables in
 * packages/ai/src/difficulty.ts's doc comments can be checked for whether a
 * point estimate is signal or noise, not just eyeballed from one seed. See
 * docs/difficulty-calibration-research.md for the resulting analysis.
 *
 * Usage (from repo root, after npm run build):
 *   node tools/calibrate_stats.mjs kgrid [--seed s] [--boards n] [--k 1,2,4,8] [--blind]
 *   node tools/calibrate_stats.mjs bidtopn [--seed s] [--boards n] [--topn 1,2,3,4,5,6]
 *   node tools/calibrate_stats.mjs forget [--seed s] [--boards n] [--forget-k 1] [--windows 0,1,2,4,8,99]
 */
const core = await import('../packages/core/dist/index.js');
const ai = await import('../packages/ai/dist/index.js');
const forget = await import('../packages/ai/dist/play-mc-forget.js');

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const SEED = opt('seed', 'stat-1');
const BOARDS = Number(opt('boards', '150'));
const bidder = new ai.Bidder(ai.loadPolicyModel('sl'));

function bidAuction(deal) {
  const calls = [];
  while (!core.auctionState(deal.dealer, calls).isOver) calls.push(bidder.chooseCall(deal, calls));
  return { calls, contract: core.finalContract(deal.dealer, calls) };
}

async function playOut(deal, contract, calls, sampledSide, k, blind) {
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
      await ai.chooseCardSampled(deal, contract, plays, {
        k,
        useAuction: !blind,
        seed: ai.mcDecisionSeed(`${SEED}#stat`, 0, plays.length),
        dealer: deal.dealer,
        calls,
      }),
    );
  }
}

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
        useAuction: true,
        seed: ai.mcDecisionSeed(`${SEED}#stat-forget`, 0, plays.length),
        dealer: deal.dealer,
        calls,
        memoryWindow,
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
const pctNonzero = (xs) => (100 * xs.filter((x) => x !== 0).length) / xs.length;
const fmt = (x, w = 6, d = 2) => x.toFixed(d).padStart(w);
const madeOrDown = (contract, tricks) => (tricks >= contract.level + 6 ? 'made' : 'down');

// ---- build board set: deal + auction + true-DD reference ------------------
console.error(`preparing ${BOARDS} boards (seed ${SEED})...`);
const boards = [];
for (let no = 1; boards.length < BOARDS; no++) {
  const deal = core.dealBoard(SEED, no);
  const { calls, contract } = bidAuction(deal);
  if (!contract) continue;
  const refTricks = await playOut(deal, contract, calls, null, 0, false);
  boards.push({ no, deal, calls, contract, refTricks });
  if (boards.length % 25 === 0) console.error(`  ${boards.length}/${BOARDS}`);
}
console.error(`ready: ${boards.length} contract boards.\n`);

if (mode === 'kgrid') {
  const K_GRID = opt('k', '1,2,4,8').split(',').map(Number);
  const BLIND = args.includes('--blind');
  console.log(
    `\n=== K-grid sweep: ${boards.length} boards, seed '${SEED}'${BLIND ? ' [BLIND]' : ' [auction-aware]'} ===`,
  );
  console.log(`   K | def mean±SE   def%>0  def max | decl mean±SE  decl%>0 | ΔNS mean±SE      | flip%`);
  for (const k of K_GRID) {
    const defC = [], declC = [], scoreD = [];
    let flips = 0;
    for (const b of boards) {
      const defTricks = await playOut(b.deal, b.contract, b.calls, 'defense', k, BLIND);
      const declTricks = await playOut(b.deal, b.contract, b.calls, 'declarer', k, BLIND);
      defC.push(defTricks - b.refTricks);
      declC.push(b.refTricks - declTricks);
      scoreD.push(
        Math.abs(
          core.boardScoreNS(b.contract, b.deal.vul, defTricks) - core.boardScoreNS(b.contract, b.deal.vul, b.refTricks),
        ),
      );
      if (madeOrDown(b.contract, defTricks) !== madeOrDown(b.contract, b.refTricks)) flips++;
    }
    console.log(
      `${String(k).padStart(4)} |${fmt(mean(defC), 6)}±${fmt(stderr(defC), 5, 3)} |${fmt(pctNonzero(defC), 7, 1)} |${fmt(
        Math.max(...defC), 7,
      )} |${fmt(mean(declC), 7)}±${fmt(stderr(declC), 5, 3)} |${fmt(pctNonzero(declC), 7, 1)} |${fmt(
        mean(scoreD), 7,
      )}±${fmt(stderr(scoreD), 5, 2)}      |${fmt((100 * flips) / boards.length, 5, 1)}`,
    );
  }
}

if (mode === 'bidtopn') {
  const TOPN_GRID = opt('topn', '1,2,3,4,5,6').split(',').map(Number);
  console.log(`\n=== Bidding-noise sweep: ${boards.length} boards, seed '${SEED}' (true-DD play both sides) ===`);
  console.log(`  topN | auctions w/dev % | deviations/auction | contract-changed% | level-changed% | ΔNS mean±SE   | max`);
  for (const topN of TOPN_GRID) {
    ai.BID_NOISE.beginner.topN = topN;
    let auctionsWithDev = 0, totalDev = 0, contractChanged = 0, levelChanged = 0;
    const scoreD = [];
    for (const b of boards) {
      const noisyCalls = [];
      let dev = 0;
      while (!core.auctionState(b.deal.dealer, noisyCalls).isOver) {
        const seed = ai.bidDecisionSeed(`${SEED}#bidstat`, b.no, noisyCalls.length);
        const pure = bidder.chooseCall(b.deal, noisyCalls);
        const noisy = bidder.chooseCall(b.deal, noisyCalls, { difficulty: 'beginner', seed });
        if (noisy !== pure) dev++;
        noisyCalls.push(noisy);
      }
      if (dev > 0) auctionsWithDev++;
      totalDev += dev;
      const noisyContract = core.finalContract(b.deal.dealer, noisyCalls);
      const changed = JSON.stringify(noisyContract) !== JSON.stringify(b.contract);
      if (changed) contractChanged++;
      if (noisyContract && b.contract && noisyContract.level !== b.contract.level) levelChanged++;
      if (!noisyContract && b.contract) levelChanged++;
      const noisyTricks = noisyContract ? await playOut(b.deal, noisyContract, noisyCalls, null, 0, false) : null;
      const noisyScore = noisyContract ? core.boardScoreNS(noisyContract, b.deal.vul, noisyTricks) : 0;
      const pureScore = core.boardScoreNS(b.contract, b.deal.vul, b.refTricks);
      scoreD.push(Math.abs(noisyScore - pureScore));
    }
    console.log(
      `${String(topN).padStart(6)} |${fmt((100 * auctionsWithDev) / boards.length, 17, 1)} |${fmt(
        totalDev / boards.length, 19, 2,
      )} |${fmt((100 * contractChanged) / boards.length, 18, 1)} |${fmt((100 * levelChanged) / boards.length, 14, 1)} |${fmt(
        mean(scoreD), 6,
      )}±${fmt(stderr(scoreD), 5, 2)} |${fmt(Math.max(...scoreD), 5)}`,
    );
  }
}

if (mode === 'forget') {
  const WINDOWS = opt('windows', '0,1,2,4,8,99').split(',').map(Number);
  const FORGET_K = Number(opt('forget-k', '1'));
  const baseline = [];
  for (const b of boards) {
    const t = await playOut(b.deal, b.contract, b.calls, 'defense', FORGET_K, false);
    baseline.push(t - b.refTricks);
  }
  console.log(`\n=== Card-forgetting sweep: ${boards.length} boards, K=${FORGET_K}, seed '${SEED}' ===`);
  console.log(`baseline (no forgetting): mean±SE ${fmt(mean(baseline), 6)}±${fmt(stderr(baseline), 5, 3)}  %>0 ${fmt(pctNonzero(baseline), 5, 1)}`);
  console.log(`  window | mean±SE        %>0   | ΔNS mean±SE     | Δ vs baseline (paired mean diff ± SE)`);
  for (const w of WINDOWS) {
    const conceded = [], scoreD = [], paired = [];
    for (let i = 0; i < boards.length; i++) {
      const b = boards[i];
      const t = await playOutForgetful(b.deal, b.contract, b.calls, 'defense', FORGET_K, w);
      const delta = t - b.refTricks;
      conceded.push(delta);
      paired.push(delta - baseline[i]);
      scoreD.push(
        Math.abs(core.boardScoreNS(b.contract, b.deal.vul, t) - core.boardScoreNS(b.contract, b.deal.vul, b.refTricks)),
      );
    }
    console.log(
      `${String(w).padStart(7)} |${fmt(mean(conceded), 6)}±${fmt(stderr(conceded), 5, 3)} ${fmt(pctNonzero(conceded), 6, 1)} |${fmt(
        mean(scoreD), 6,
      )}±${fmt(stderr(scoreD), 5, 2)}     |${fmt(mean(paired), 6, 3)} ± ${fmt(stderr(paired), 5, 3)}`,
    );
  }
}

await ai.destroySharedDdPool();
