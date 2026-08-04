#!/usr/bin/env node
/**
 * Simulation for the question raised against PR #136 (the Analyze screen's
 * "Par" verdict): how often does true double-dummy par — the DDS DealerPar
 * score, "both sides bid and play perfectly, all hands face up" — sit BELOW
 * a score the benchmark house players ("The Novice"/"The Regular"/"The
 * Shark") actually achieve? That is not a bug: par is the equilibrium score
 * for perfect bidding+play by BOTH sides, and real opponents (robots, at a
 * difficulty tier, playing a fallible SAYC auction) routinely overbid or
 * underbid, letting the OTHER side beat what perfect defense/offense would
 * have held them to. This script measures how often that happens, on the
 * board's own NS-signed axis (matching how "Par ... to your side" is shown).
 *
 * Faithfully mirrors production's actual decision-making (server/src/
 * ai-players.ts's tierStrategy + server/src/game.ts's advanceRobots/
 * robotCard), reimplemented standalone (no DB/server) so many boards can be
 * swept quickly:
 *   - South (+ North whenever N-S declares, i.e. whichever hand(s) the
 *     "house" player controls) bids/plays at the house tier's own dials
 *     (BID_NOISE / MC_SAMPLES.kOpp / PLAY_NOISE — never the kPartner floor,
 *     which belongs only to a ROBOT partner).
 *   - North/East/West robot decisions (auction always; play only when EW
 *     declares, or robot North defending) use the BOARD's own difficulty
 *     tier, with robot North floored at kPartner (PARTNER_FLOOR) exactly as
 *     robotCard() does.
 *   - Board difficulty defaults to 'intermediate' — the schema default for
 *     new users and what demo ambient ai_field tournaments are stamped with
 *     (CONTRIBUTING.md), i.e. the representative case for where house players
 *     are actually seen. Override with --board-difficulty.
 *
 * Claims (server-side DD-optimal fast-forward once a position is 100%
 * determined) are NOT simulated — decisions keep sampling MC-DD to the end
 * of the hand instead of switching to true-DD play. Harmless for this
 * question: near the end of a hand K-sample MC converges on optimal play
 * anyway, and calibrate_stack.mjs (the existing calibration tool) makes the
 * same simplification.
 *
 * Usage (from repo root, after `npm run build -w @bridge/core -w @bridge/ai`):
 *   node tools/simulate_par_vs_house.mjs [--seed s] [--boards n] [--board-difficulty tier]
 */
import { Dds, loadDds } from '../packages/ai/vendor/bridge-dds/api.js';
const core = await import('../packages/core/dist/index.js');
const ai = await import('../packages/ai/dist/index.js');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const SEED = opt('seed', 'par-sim-1');
const BOARDS = Number(opt('boards', '500'));
const BOARD_DIFFICULTY = opt('board-difficulty', 'intermediate');
if (!ai.DIFFICULTIES.includes(BOARD_DIFFICULTY)) {
  throw new Error(`--board-difficulty must be one of ${ai.DIFFICULTIES.join(', ')}`);
}

const bidder = new ai.Bidder(ai.loadPolicyModel('sl'));
const dds = new Dds(await loadDds());

const NORTH = 0,
  SOUTH = 2;
const TIERS = ai.DIFFICULTIES; // ['beginner', 'intermediate', 'expert']
const TIER_HANDLE = { beginner: 'The Novice', intermediate: 'The Regular', expert: 'The Shark' };

/** our strain (0=♣..4=NT) -> DDS trump order (0=♠ 1=♥ 2=♦ 3=♣ 4=NT) */
function ddsTrump(strain) {
  return strain === 4 ? 4 : 3 - strain;
}
/** Vulnerability -> DDS encoding: 0=None 1=Both 2=NS 3=EW */
function ddsVul(vul) {
  if (vul.ns && vul.ew) return 1;
  if (vul.ns) return 2;
  if (vul.ew) return 3;
  return 0;
}

/** True double-dummy par (NS-signed), straight from DealerPar over the full 20-problem DD table. */
function dealerPar(deal) {
  const table = dds.CalcDDTablePBN({ cards: core.dealToPbn(deal) });
  return dds.DealerPar(table, deal.dealer, ddsVul(deal.vul)).score;
}

/** One full auction: `seat` decides via `pick(seat, calls)`. */
function bidAuction(deal, pick) {
  const calls = [];
  for (;;) {
    const state = core.auctionState(deal.dealer, calls);
    if (state.isOver) return calls;
    calls.push(pick(state.turn, calls));
  }
}

/**
 * One full play, mirroring robotCard()/tierStrategy exactly: `houseControls`
 * says whether the house player is on lead for this seat (their own tier,
 * kOpp/auctionAware/playTopN — the doc-commented "never kPartner" rule);
 * otherwise it's a board-difficulty robot, with seat 0 (North) getting the
 * kPartner floor whenever it is NOT house-controlled (i.e. EW declares and
 * North defends).
 */
async function playHand(deal, contract, calls, houseTier, houseSeedBase, robotSeedBase) {
  const nsDeclares = contract.declarer % 2 === 0;
  const houseControls = (seat) => (nsDeclares ? seat === NORTH || seat === SOUTH : seat === SOUTH);
  const plays = [];
  for (;;) {
    const ps = core.playState(deal, contract, plays);
    if (ps.isOver) return ps.declarerTricks;
    const legal = core.legalCards(deal, ps);
    let card;
    if (legal.length <= 1) {
      card = legal[0];
    } else if (houseControls(ps.handToPlay)) {
      const t = ai.MC_SAMPLES[houseTier];
      card = await ai.chooseCardSampled(deal, contract, plays, {
        k: t.kOpp,
        useAuction: t.auctionAware,
        playTopN: ai.PLAY_NOISE[houseTier].topN,
        seed: ai.mcDecisionSeed(houseSeedBase, 0, plays.length),
        dealer: deal.dealer,
        calls,
      });
    } else {
      const isPartner = ps.handToPlay === NORTH;
      const t = ai.MC_SAMPLES[BOARD_DIFFICULTY];
      card = await ai.chooseCardSampled(deal, contract, plays, {
        k: isPartner ? t.kPartner : t.kOpp,
        useAuction: isPartner ? true : t.auctionAware,
        playTopN: isPartner ? 1 : ai.PLAY_NOISE[BOARD_DIFFICULTY].topN,
        seed: ai.mcDecisionSeed(robotSeedBase, 0, plays.length),
        dealer: deal.dealer,
        calls,
      });
    }
    plays.push(card);
  }
}

/** One house tier's board: South bids at its own tier, N/E/W bid at the board's tier. */
async function playAsHouse(deal, boardNo, tier) {
  const houseSeedBase = `${SEED}:house:${tier}`;
  const robotSeedBase = `${SEED}:robots:${BOARD_DIFFICULTY}`;
  const calls = bidAuction(deal, (seat, calls) =>
    bidder.chooseCall(deal, calls, {
      difficulty: seat === SOUTH ? tier : BOARD_DIFFICULTY,
      seed: ai.bidDecisionSeed(seat === SOUTH ? houseSeedBase : robotSeedBase, boardNo, calls.length),
    }),
  );
  const contract = core.finalContract(deal.dealer, calls);
  if (!contract) return 0; // passed out
  const tricks = await playHand(deal, contract, calls, tier, houseSeedBase, robotSeedBase);
  return core.boardScoreNS(contract, deal.vul, tricks);
}

console.error(
  `simulating ${BOARDS} boards (seed=${SEED}, board-difficulty=${BOARD_DIFFICULTY}), house tiers: ${TIERS.join(', ')}...`,
);

let parBelowAny = 0;
let parBelowRegular = 0;
const rows = [];

for (let no = 1; no <= BOARDS; no++) {
  const deal = core.dealBoard(SEED, no);
  const par = dealerPar(deal);
  const scores = {};
  for (const tier of TIERS) scores[tier] = await playAsHouse(deal, no, tier);

  const anyBeatsPar = TIERS.some((t) => scores[t] > par);
  const regularBeatsPar = scores.intermediate > par;
  if (anyBeatsPar) parBelowAny++;
  if (regularBeatsPar) parBelowRegular++;

  rows.push({ no, par, ...scores });
  if (no % 50 === 0) console.error(`  ${no}/${BOARDS}`);
}

console.log(`\nboards simulated: ${BOARDS}  (seed=${SEED}, board-difficulty=${BOARD_DIFFICULTY})`);
console.log(`house tiers: ${TIERS.map((t) => `${TIER_HANDLE[t]}=${t}`).join(', ')}\n`);
console.log(
  `Par lower than ANY house player:            ${parBelowAny}/${BOARDS}  (${((100 * parBelowAny) / BOARDS).toFixed(1)}%)`,
);
console.log(
  `Par lower than The Regular (intermediate):   ${parBelowRegular}/${BOARDS}  (${((100 * parBelowRegular) / BOARDS).toFixed(1)}%)`,
);

// Per-tier breakdown, for context.
for (const tier of TIERS) {
  const n = rows.filter((r) => r[tier] > r.par).length;
  console.log(`  ${TIER_HANDLE[tier].padEnd(12)} (${tier.padEnd(12)}) beats par: ${n}/${BOARDS} (${((100 * n) / BOARDS).toFixed(1)}%)`);
}

const outPath = process.env.PAR_SIM_OUT;
if (outPath) {
  const fs = await import('node:fs');
  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
  console.error(`\nwrote per-board rows to ${outPath}`);
}
