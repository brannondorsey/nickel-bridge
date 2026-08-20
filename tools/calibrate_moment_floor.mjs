#!/usr/bin/env node
/**
 * Calibrate MOMENT_FLOOR (server/src/analyze.ts) against real production
 * play — the sweep its own doc comment asks for: "calibrate against
 * production the way FULL_TILT was (a read-only sweep counting moments per
 * board at each candidate floor) and record the date and n when you do."
 *
 * WHAT MOMENT_FLOOR GATES. Analyze's moments ledger only shows a play
 * decision when THREE things all hold: (1) the DD trace says the card
 * actually cost tricks against the true 52 cards (stage 1), (2) that trick
 * loss is worth at least MOMENT_FLOOR matchpoint percentage points against
 * the board's REAL field (stage 2 — the gate this tool sweeps), and
 * (3) the sampled, imperfect-information engine from the player's own seat
 * would genuinely have done better too, i.e. it wasn't excusable hindsight
 * (stage 3). See analyze.ts's module doc comment for the full pipeline.
 *
 * WHY THIS CAN'T BE SWEPT FROM A SINGLE PRODUCTION RUN OF THE REAL CODE.
 * computeCore only runs stage 3 (scoreCardsSampled — k full sampled-DD
 * solves, not cheap) on candidates that ALREADY clear the shipped floor, so
 * a normal analysis never learns the fault verdict for a candidate sitting
 * just under 10 points — there's nothing cached to ask "would floor=6 have
 * shown this?". This tool reimplements computeCore's stage-1+3 loop
 * (against the exported primitives analyze.ts itself calls — analysePlayTricks,
 * scoreCardsSampled, deriveClaimBoundary, gradeFromDeficit, matchpoints,
 * boardScoreNS — never re-deriving DD-loss arithmetic by hand) WITHOUT the
 * floor gate, so every real DD-loss candidate gets a genuine stage-3 verdict
 * once, however small its cost — then floor thresholds are applied
 * afterward, post-hoc, over that one expensive pass. This is the same shape
 * calibrate_k.mjs and calibrate_placement.mjs already use: call the shipped
 * primitives so the answer can't drift from production, reimplement only the
 * SWEEP driver around them.
 *
 * WHAT n MEANS HERE. Each trace row is one human-owned FINISHED board,
 * already scored against its real field (house personas included) — not a
 * synthetic deal. A "moment" at floor F is a ply where mpCost >= F (or,
 * on the rare single-field board, ddLoss >= 1 — the same fallback gate
 * computeCore uses) AND stage 3 finds a genuine, findable fault.
 *
 * TWO STAGE-3 RULES ARE SWEPT SIDE BY SIDE, over the same candidates and the
 * same sampled draw:
 *
 *   OLD — the sampled engine merely DISAGREED with the card played
 *         (deficit > 0). This is what shipped until the excusal below.
 *   NEW — and something the engine rated top is DD-optimal at that node, i.e.
 *         actually recovers the trick stage 1 is charging for. Its top is a
 *         TIED SET, read the way sampleFindability reads it. This is what
 *         ships today.
 *
 * The old column is not a setting production can choose; it is kept so the
 * cost of that tightening stays a measured number rather than an assertion.
 * Because both verdicts come off one scoreCardsSampled call per candidate,
 * the difference between the columns is purely the rule — not sampling
 * noise between two runs. The extra true-deal solve the new rule needs is
 * paid only on candidates that clear the free deficit test, matching
 * sampleFindability's own ordering, so the cost here mirrors production's.
 *
 * Usage (after `npm run build`):
 *   node .claude/skills/player-outreach/scripts/analyze_trace.mjs "$SCRATCH/analyze-trace.json"
 *   node tools/calibrate_moment_floor.mjs --trace "$SCRATCH/analyze-trace.json" [--floors 2,4,6,8,10,15,20,25] [--json out.json]
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'nb-calib-moment-')), 'throwaway.db');
process.env.AI_PLAYERS = '0';

const core = await import('../packages/core/dist/index.js');
const ai = await import('../packages/ai/dist/index.js');
const { HUMAN_SEAT, humanControls } = await import('../server/dist/game.js');
const { ANALYZE_K, MOMENT_FLOOR, gradeFromDeficit, deriveClaimBoundary } = await import('../server/dist/analyze.js');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const TRACE_PATH = opt('trace', null);
const FLOORS = opt('floors', '2,4,6,8,10,12,15,20,25,30').split(',').map(Number);
const JSON_OUT = opt('json', null);
const LIMIT = Number(opt('limit', '0')) || Infinity; // truncate the trace — useful for a fast dry run
if (!TRACE_PATH) {
  console.error('usage: node tools/calibrate_moment_floor.mjs --trace <path> [--floors 2,4,...] [--json out.json] [--limit N]');
  process.exit(1);
}
const trace = JSON.parse(readFileSync(TRACE_PATH, 'utf8'));
trace.boards = trace.boards.slice(0, LIMIT);

function substitutePct(scores, myIndex, myScore) {
  const next = [...scores];
  next[myIndex] = myScore;
  return core.matchpoints(next)[myIndex].pct;
}

/**
 * computeCore's stage-1+3 loop, minus the floor gate: every DD-loss
 * candidate gets a stage-3 verdict, however small its matchpoint cost.
 * Mirrors server/src/analyze.ts's computeCore exactly except for that one
 * omission (search analyze.ts for "Stage 3 — the findability verdict" to
 * diff against the shipped version if this ever needs re-syncing).
 */
async function candidatesFor(b) {
  if (!b.contract) return null; // passed out — nothing to grade
  const deal = core.dealBoard(b.seed, b.boardNo);
  const contract = b.contract;
  const singleField = b.scores.length <= 1;
  const actualPct = singleField ? null : core.matchpoints(b.scores)[b.myIndex].pct;
  const declaring = contract.declarer % 2 === HUMAN_SEAT % 2;

  const claimedAtPly = b.claimedAtPly ?? (await deriveClaimBoundary(deal, contract, b.plays, b.claimRule));
  const boundary = claimedAtPly ?? b.plays.length;

  const ddTricks = await ai.analysePlayTricks(deal, contract, b.plays, 'background');
  const actualTricks = b.tricksDeclarer ?? ddTricks[ddTricks.length - 1];

  const candidates = [];
  for (let ply = 0; ply < Math.min(b.plays.length, ddTricks.length - 1, boundary); ply++) {
    const prefix = b.plays.slice(0, ply);
    const ps = core.playState(deal, contract, prefix);
    if (!humanControls(ps.handToPlay, contract)) continue;
    if (core.legalCards(deal, ps).length <= 1) continue;
    const rawDelta = ddTricks[ply + 1] - ddTricks[ply];
    const ddLoss = declaring ? -rawDelta : rawDelta;
    if (ddLoss <= 0) continue;

    const cfTricksDeclarer = Math.max(0, Math.min(13, actualTricks + (declaring ? ddLoss : -ddLoss)));
    const cfScoreNS = core.boardScoreNS(contract, deal.vul, cfTricksDeclarer);
    const cfPct = singleField ? null : substitutePct(b.scores, b.myIndex, cfScoreNS);
    const mpCost = cfPct === null || actualPct === null ? null : cfPct - actualPct;

    // stage 3 runs unconditionally here (the one deliberate deviation from
    // computeCore) so every candidate carries a real deficit to threshold
    // against, at whatever floor the sweep below asks about.
    const { legal, totals } = await ai.scoreCardsSampled(deal, contract, prefix, {
      k: ANALYZE_K,
      seed: `${b.tid}:${b.boardNo}:analyze-cal:${ply}`,
      dealer: deal.dealer,
      calls: b.calls,
      useAuction: true,
      priority: 'background',
    });
    // The engine's preference is the TIED top of the sampled totals, exactly
    // as sampleFindability reads it — see its comment on why the tie is left
    // open for the solve to break rather than resolved by legalCards' order.
    const top = Math.max(...legal.map((c) => totals.get(c) ?? 0));
    const tied = legal.filter((c) => (totals.get(c) ?? 0) === top);
    const played = b.plays[ply];
    const deficit = (top - (totals.get(played) ?? 0)) / ANALYZE_K;

    // Stage 3's SECOND excusal: does anything the sampled engine was willing
    // to play actually recover the trick stage 1 is charging for? Only
    // meaningful once the free deficit test has passed, and ordered after it
    // exactly as sampleFindability orders them, so the extra true-deal solve
    // is paid on the same candidates production pays it on. Both verdicts
    // come off ONE sampled draw, which is what makes the old-vs-new
    // comparison below a like-for-like measurement rather than two runs.
    //
    // `partial` splits the excused population in two, because they are not
    // the same finding: a pick that recovers NOTHING is the false accusation
    // this rule was written for, while one that recovers SOME of a multi-trick
    // loss was a real (if smaller) improvement, dropped because the ledger's
    // cfScoreNS promises the whole loss back. Reporting them as one number
    // would let "every retired moment was a false accusation" go unchecked.
    let ddOptimalBest = false;
    let partial = false;
    if (deficit > 0) {
      const solve = await ai.solveFutureTricks(deal, contract, prefix, 'background');
      ddOptimalBest = tied.some((c) => (solve.cardScores.get(c) ?? -1) === solve.bestScore);
      if (!ddOptimalBest) {
        const bestTied = Math.max(...tied.map((c) => solve.cardScores.get(c) ?? -1));
        partial = bestTied > (solve.cardScores.get(played) ?? -1);
      }
    }

    candidates.push({ ddLoss, mpCost, deficit, ddOptimalBest, partial, singleField });
  }
  return candidates;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// ---- collect every candidate, once, at every board ------------------------
const perBoard = []; // one entry per board with >=1 DD-loss candidate: its list of {mpCost, deficit, singleField}
let boardsWithNoDdLoss = 0;
let boardsPassedOut = 0;
let singleFieldBoards = 0;
let done = 0;
for (const b of trace.boards) {
  if (b.scores.length <= 1) singleFieldBoards++;
  const candidates = await candidatesFor(b);
  done++;
  if (done % 100 === 0) console.error(`analyzed ${done}/${trace.boards.length} boards`);
  if (candidates === null) { boardsPassedOut++; continue; }
  if (candidates.length === 0) { boardsWithNoDdLoss++; continue; }
  perBoard.push(candidates);
}

// ---- sweep floors -----------------------------------------------------
const graded = perBoard.filter((cs) => !cs[0].singleField); // singleField boards never surface a moment regardless of floor (mpCost stays null) — see analyze.ts's assembleMoments
// Two stage-3 rules, swept side by side over the SAME candidates:
//   OLD — the engine merely DISAGREED with the card played (deficit > 0).
//   NEW — and its own pick actually recovers the loss (ddOptimalBest), the
//         rule sampleFindability ships today.
// The old column is kept so the cost of that tightening stays measurable
// rather than asserted; it is not a configuration production can select.
const overFloor = (c, floor) => c.mpCost !== null && c.mpCost >= floor;
const results = [];
for (const floor of FLOORS) {
  const oldPerBoard = graded.map((cs) => cs.filter((c) => c.deficit > 0 && overFloor(c, floor)).length);
  const newPerBoard = graded.map((cs) => cs.filter((c) => c.deficit > 0 && c.ddOptimalBest && overFloor(c, floor)).length);
  const boardsOld = oldPerBoard.filter((n) => n > 0).length;
  const boardsWithAMoment = newPerBoard.filter((n) => n > 0).length;
  results.push({
    floor,
    boardsOld,
    pctOld: (100 * boardsOld) / graded.length,
    boardsWithAMoment,
    pctWithAMoment: (100 * boardsWithAMoment) / graded.length,
    meanMomentsOld: mean(oldPerBoard),
    meanMoments: mean(newPerBoard),
    medianMomentsAmongShown: median(newPerBoard.filter((n) => n > 0)),
  });
}

// ---- report -----------------------------------------------------------
const totalCandidates = perBoard.reduce((s, cs) => s + cs.length, 0);
const excusedDeficit = perBoard.reduce((s, cs) => s + cs.filter((c) => c.deficit <= 0).length, 0);
const excusedDead = perBoard.reduce(
  (s, cs) => s + cs.filter((c) => c.deficit > 0 && !c.ddOptimalBest && !c.partial).length,
  0,
);
const excusedPartial = perBoard.reduce((s, cs) => s + cs.filter((c) => c.deficit > 0 && c.partial).length, 0);
const chargeable = totalCandidates - excusedDeficit - excusedDead - excusedPartial;
console.log(`\n${trace.boards.length} human-owned finished boards captured ${trace.capturedOn}`);
console.log(`  ${boardsPassedOut} passed out, ${singleFieldBoards} single-field, ${boardsWithNoDdLoss} with zero real DD-loss candidates`);
console.log(`  ${perBoard.length} boards had >=1 DD-loss candidate (${totalCandidates} candidates total)`);
console.log(`  stage 3 excusals, in the order sampleFindability applies them:`);
console.log(
  `    ${excusedDeficit} (${((100 * excusedDeficit) / totalCandidates).toFixed(1)}%) the engine would have played the card itself (deficit <= 0)`,
);
console.log(
  `    ${excusedDead} (${((100 * excusedDead) / totalCandidates).toFixed(1)}%) the engine disagreed but nothing it preferred recovers ANY of the loss`,
);
console.log(
  `    ${excusedPartial} (${((100 * excusedPartial) / totalCandidates).toFixed(1)}%) ...recovers SOME of it, but not the whole charged loss (see sampleFindability)`,
);
console.log(`    ${chargeable} (${((100 * chargeable) / totalCandidates).toFixed(1)}%) genuinely chargeable and findable`);
console.log(`  ${graded.length} of those boards had a real (non-single-field) field to grade against — the floor sweep below is over these`);
console.log(`\n       |            OLD rule (disagreed only) |            NEW rule (must recover)   |`);
console.log(` floor | boards |      % | mean/board | boards |      % | mean/board | median (>0)`);
for (const r of results) {
  console.log(
    `${String(r.floor).padStart(6)} | ${String(r.boardsOld).padStart(6)} | ${r.pctOld.toFixed(1).padStart(5)}% | ${r.meanMomentsOld.toFixed(2).padStart(10)} | ` +
      `${String(r.boardsWithAMoment).padStart(6)} | ${r.pctWithAMoment.toFixed(1).padStart(5)}% | ${r.meanMoments.toFixed(2).padStart(10)} | ${r.medianMomentsAmongShown.toFixed(1).padStart(11)}`,
  );
}
const atShipped = results.find((r) => r.floor === MOMENT_FLOOR);
if (atShipped) {
  console.log(
    `\nAt the shipped MOMENT_FLOOR=${MOMENT_FLOOR}: ${atShipped.boardsOld} boards would have shown a moment under the OLD rule, ` +
      `${atShipped.boardsWithAMoment} under the NEW one` +
      ` — ${(atShipped.pctOld - atShipped.pctWithAMoment).toFixed(1)} percentage points of graded boards ` +
      `(${atShipped.boardsOld - atShipped.boardsWithAMoment} boards) lose every moment they had, as false accusations.`,
  );
}
console.log(
  `\ncurrent MOMENT_FLOOR = ${MOMENT_FLOOR}. reading the table: pick the floor where "% of graded boards"` +
    `\nmatches how often a finished board should have something to say — too high and most boards come back` +
    `\nempty even after a real, findable mistake; too low and the ledger nags on noise. Edit MOMENT_FLOOR in` +
    `\nserver/src/analyze.ts accordingly, record this date + n in its doc comment (matching FULL_TILT's own` +
    `\ncomment in server/src/compare.ts), and bump ANALYZE_VERSION.`,
);

if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    JSON.stringify({ capturedOn: trace.capturedOn, boards: trace.boards.length, graded: graded.length, results }, null, 2),
  );
  console.error(`wrote ${JSON_OUT}`);
}
await ai.destroySharedDdPool();
