import {
  ddTableTricks,
  analysePlayTricks,
  calcDdTable,
  dealerParFor,
  isOutcomeInvariant,
  scoreCardsSampled,
  solveFutureTricks,
} from '@bridge/ai';
import {
  Call,
  Card,
  Contract,
  Deal,
  Seat,
  auctionState,
  boardScoreNS,
  contractLabel,
  finalContract,
  legalCards,
  matchpoints,
  playState,
} from '@bridge/core';
import { ClaimRule, TournamentRow, db } from './db.js';
import { GameBoard, HUMAN_SEAT, bidder, boardFieldRows, humanControls } from './game.js';
import { claimRule } from './tournaments.js';

/**
 * Analyze — the post-board review's verdict pipeline ("walking a finished
 * board back, without lying about it"). Two engines, because double dummy
 * alone would result-merchant a beginner:
 *
 *   COST   (stage 1+2): AnalysePlayPBN's DD trace says what each card cost
 *          against THESE 52 cards, converted to matchpoints against the real
 *          field — a trick nobody else found is worth nothing, which is what
 *          keeps the screen quiet on a board the whole field butchered.
 *   FAULT  (stage 3): scoreCardsSampled — the same sampled-DD machinery the
 *          robots play with — says whether the better card was FINDABLE from
 *          the player's own seat. High cost with no fault is DROPPED, not
 *          shown: a card nobody could reasonably find from that seat isn't a
 *          moment just because an omniscient trace prefers something else —
 *          a well-played board should come back moment-free, not decorated
 *          with a stack of "not your fault" stamps.
 *
 * Stage order is load-bearing: DD is the cheap filter, sampled DD the
 * expensive verdict (k full solves of DIFFERENT deals per candidate — no
 * shared transposition table), so the verdict only runs on candidates that
 * clear the matchpoint floor — AT COMPUTE TIME, the first time, as the cost
 * -saving filter it's for. A field that grows afterward doesn't leave a
 * ply stuck below a floor it has since cleared: getBoardAnalysis's
 * backfillDriftedPlies gives any such ply its one stage-3 solve on the
 * serve that discovers the drift, so the floor filter is deliberately not
 * a one-shot verdict. Stage 4 (par + counterfactual auctions, CalcDDTablePBN
 * at p90 ~576ms) runs only when a lens that shows it is opened, and is
 * cached separately for the same reason.
 *
 * Everything here is a pure, seeded function of the finished board plus the
 * field rows, dispatched at 'background' priority (a live card-play solve
 * beats a report loading; STARVATION_PROMOTE_MS bounds the wait). The cache
 * (board_analyses, see db.ts) and the screen are therefore the same claim
 * made twice — a recompute (or a drift backfill) is byte-identical to what a
 * fresh compute against the SAME field would produce, until ANALYZE_VERSION
 * bumps.
 */

/**
 * Sampled-DD layouts per findability verdict. Matches MC_SAMPLES.expert.kOpp
 * and PARTNER_FLOOR: Analyze judges the player against the strongest belief
 * model the app has — deliberately more generous than raw DD. Raising it
 * costs solves linearly and saturates like the K difficulty dial
 * (docs/difficulty-tuning-guide.md).
 */
export const ANALYZE_K = 8;

/**
 * The gate on the moments ledger, in matchpoint percentage points. Originally
 * shipped at 10 on the judgement "fields are small — one place in a
 * five-player field is 25 points — so 10 is roughly half a place," which
 * assumed a smaller field than production actually has.
 *
 * Measured 2026-08-13 against production, read-only
 * (`.claude/skills/player-outreach/scripts/analyze_trace.mjs` +
 * `tools/calibrate_moment_floor.mjs`, the same two-script shape as
 * `placement_trace.mjs`/`calibrate_placement.mjs`): 1237 human-owned
 * finished boards, mean field size 6.7 (not 5) — so "one place" is closer to
 * 15 points and "half a place" to 7-8, not 10. 733 of those boards had at
 * least one real double-dummy trick loss; of the 1280 such candidates, 280
 * (21.9%) were excused by stage 3 as unfindable from the seat, leaving 486
 * boards (39.3% of all 1237) with at least one genuine, gradable fault —
 * that 486 is the ceiling no floor value can exceed. At floor=10 only 433 of
 * those (89.1% of the ceiling) surfaced a moment; floor=8 recovers 477
 * (98.1% of the ceiling) while floors below 8 add back fewer than ten more
 * boards, meaning stage 3's excusal is already doing the "don't nag on
 * noise" work and there was no real risk in lowering the gate. 8 is the
 * calibrated value below.
 *
 * THE one number to move if the screen starts nagging (raise it) or stays
 * too quiet on boards with real, findable mistakes (lower it); re-run the
 * two scripts above and record the date and n when you do.
 */
export const MOMENT_FLOOR = 8;

/** Ledger rows shown — Chess.com's Key Moments shape: a handful of turning
 *  points beats a narration. Overflow is counted and stated, never silent. */
export const MAX_MOMENTS = 5;

/**
 * Cache key epoch. Bump on ANY deliberate robot change (invariant 1's list),
 * any constant above, a grade-band change, or a stage-3 scoring change — a
 * cached analysis computed against different robots is a stale accusation.
 *
 * Deliberately NOT bumped for the pessimistic claim gate, which is the one
 * documented exemption so far and worth stating so the next reader doesn't
 * think the rule was simply overlooked. The version exists to throw away
 * analyses that have become WRONG. A board's claim rule is stamped on its
 * tournament at creation and never changes (see db.ts's claim_rule migration),
 * and the migration stamped every tournament that already existed
 * 'optimistic' — so every cache row in existence describes a board whose gate
 * is bit-for-bit the one it was computed under, and deriveClaimBoundary
 * returns exactly what it returned before for all of them. Bumping would force
 * a full stage-1-to-3 recompute of every cached board — the expensive path, on
 * one vCPU — to arrive at byte-identical output.
 *
 * The precondition is that immutability. Anything that ever flips claim_rule
 * on an existing tournament must delete that tournament's board_analyses rows.
 */
export const ANALYZE_VERSION = 4; // 4: MOMENT_FLOOR recalibrated 10 -> 8 against measured production field sizes

export type CardGrade = 0 | 1 | 2 | 3;

/**
 * Findability grade from the sampled verdict's average trick deficit —
 * (bestTotal − playedTotal) / k, i.e. how many tricks the played card gave up
 * per sampled layout, judged from the player's own seat. Only ever called on
 * a POSITIVE deficit: computeCore's stage-3 loop drops anything at or below
 * zero before grading it — that means the sampled engine's own pick IS the
 * card played (or worse), so there is nothing to grade and nothing to show.
 * The bands below are judgement values (ship on judgement, calibrate on
 * data — see MOMENT_FLOOR). Changing them is an ANALYZE_VERSION bump.
 */
export function gradeFromDeficit(deficit: number): CardGrade {
  if (deficit < 0.5) return 2;
  if (deficit < 1.5) return 1;
  return 0;
}

/** One graded human card decision (an error by the DD trace, stage 1). */
export interface PlyAnalysis {
  /** plays[] index */
  ply: number;
  /** 1-based trick number */
  trick: number;
  /** hand that played it (humanControls-true in this board's orientation) */
  seat: Seat;
  card: Card;
  /** tricks the HUMAN'S SIDE lost at this card per the DD trace (> 0 always — non-errors aren't listed) */
  ddLoss: number;
  /** counterfactual final declarer tricks had this card not lost them (rest of the hand as played) */
  cfTricksDeclarer: number;
  cfScoreNS: number;
  /** counterfactual matchpoint pct after SUBSTITUTING cfScoreNS into the real field; null in a single field */
  cfPct: number | null;
  /** cfPct − actualPct, the moment-ranking axis; null in a single field */
  mpCost: number | null;
  /**
   * stage-3 findability — only for candidates that cleared the floor AND
   * turned out to be a genuine fault. A candidate the sampled engine would
   * also have played (deficit <= 0) never reaches here: computeCore drops it
   * before this field is populated, so its ply carries no PlyAnalysis at all
   * (see the doc comment on that stage).
   */
  sampled: {
    /** the card the sampled engine plays from the player's seat */
    bestCard: Card;
    /** average tricks the played card gave up across the k sampled layouts */
    deficit: number;
    grade: CardGrade;
  } | null;
}

/** Stages 1–3, cached as board_analyses.core. */
export interface AnalysisCore {
  boardNo: number;
  contract: Contract | null;
  /** first server-played ply of a resolved claim (persisted or re-derived); null = no claim */
  claimedAtPly: number | null;
  /** the whole field is just this player — costs are null and moments empty */
  singleField: boolean;
  /**
   * The field as SERVED: the board's NS scores in boardFieldRows order and
   * this player's index in them, refreshed against the live field on every
   * request by refreshMatchpointLayer (the stored cache row keeps the
   * compute-time values, which nothing reads back except as a record). See
   * that function for why the matchpoint layer is serve-time rather than
   * frozen — one field for the whole response, and a page refresh sees
   * tables that finished since the audit first ran.
   */
  fieldScores: number[];
  myIndex: number;
  /** the player's real matchpoint pct on this board; null in a single field */
  actualPct: number | null;
  /** AnalysePlayPBN trace (declaring-side absolute totals, length min(cards+1, 49)); null on a pass-out */
  ddTricks: number[] | null;
  plies: PlyAnalysis[];
}

/** One human call's counterfactual (stage 4). */
export interface CallAnalysis {
  /** calls[] index of the human's call */
  callIndex: number;
  call: Call;
  bestCall: Call;
  /** null when the robot's preferred call was the one played */
  cf: {
    /** the re-run auction from the substituted call on (the app's opinion, not a fact) */
    calls: Call[];
    contract: Contract | null;
    contractLabel: string;
    /** DD tricks for the counterfactual contract's declarer; null on a cf pass-out */
    ddTricks: number | null;
    scoreNS: number;
    cfPct: number | null;
    /** cfPct − actualPct: positive = the robot's auction was worth matchpoints */
    mpGain: number | null;
  } | null;
}

/** Stage 4, cached as board_analyses.par (NULL until a lens that shows it is opened). */
export interface AnalysisPar {
  /** DealerPar score, NS-signed */
  parScore: number;
  /** DealerPar contract strings ("4S N +620"-shaped, straight from DDS) */
  parContracts: string[];
  calls: CallAnalysis[];
}

export interface Moment {
  kind: 'play' | 'bid';
  /** play moments */
  ply?: number;
  trick?: number;
  card?: Card;
  grade?: CardGrade;
  /** bid moments */
  callIndex?: number;
  call?: Call;
  /** matchpoint pct points this decision cost (the ranking axis) */
  mpCost: number;
}

/** What the endpoint serves: the cached pieces plus serve-time moment assembly. */
export interface AnalysisView extends AnalysisCore {
  version: number;
  moments: Moment[];
  /** moments beyond MAX_MOMENTS, counted rather than silently dropped */
  setAside: number;
  par: AnalysisPar | null;
  /**
   * MOMENT_FLOOR, served so the client can caption an unjudged ply whose
   * REFRESHED cost has drifted over the floor honestly (stage 3's selection
   * is as-of-compute; the matchpoint layer is as-of-serve)
   */
  momentFloor: number;
}

const stmtGetAnalysis = db.prepare(`SELECT version, core, par FROM board_analyses WHERE board_id = ?`);
const stmtPutAnalysis = db.prepare(
  `INSERT INTO board_analyses (board_id, version, core, par) VALUES (?, ?, ?, ?)
   ON CONFLICT(board_id) DO UPDATE SET version = excluded.version, core = excluded.core, par = excluded.par, updated_at = unixepoch()`,
);
const stmtPutPar = db.prepare(`UPDATE board_analyses SET par = ?, updated_at = unixepoch() WHERE board_id = ?`);

/** N-S is the human's side; the human's side declares when declarer is N or S. */
function humanSideDeclares(contract: Contract): boolean {
  return contract.declarer % 2 === HUMAN_SEAT % 2;
}

/**
 * The claim boundary for a board whose row predates the claimed_at_ply
 * column: replay the exact gate advanceRobots runs — at every non-forced
 * node, does either side have 100% of the remaining tricks double-dummy, and
 * (under 'pessimistic') is the position outcome-invariant besides? Both halves
 * are deterministic, so this finds precisely the ply where the live game
 * claimed (or none). Costs one solve per decision node once, then cached.
 *
 * `rule` is required rather than defaulted on purpose: it is the tournament's
 * own claim_rule, and a caller that silently re-derived a legacy board under
 * today's gate would answer a different question than the one the live game
 * asked — the exact drift this whole change is built to prevent.
 *
 * Exported for rehearsal.ts: a "Play From Here" branch must never be allowed
 * past a board's claim boundary (the server already played both sides from
 * there, true-DD — there is nothing left to redecide), and this is the exact
 * same gate that boundary is defined by.
 */
export async function deriveClaimBoundary(
  deal: Deal,
  contract: Contract,
  plays: Card[],
  rule: ClaimRule,
): Promise<number | null> {
  for (let i = 0; i < plays.length; i++) {
    const prefix = plays.slice(0, i);
    const ps = playState(deal, contract, prefix);
    if (ps.isOver) return null;
    if (legalCards(deal, ps).length <= 1) continue;
    const solve = await solveFutureTricks(deal, contract, prefix, 'background');
    const remaining = 13 - ps.completedTricks.length;
    if (solve.bestScore !== remaining && solve.bestScore !== 0) continue;
    if (rule === 'optimistic') return i;
    const claimingSide = (solve.bestScore === remaining ? ps.handToPlay % 2 : (ps.handToPlay + 1) % 2) as 0 | 1;
    if (isOutcomeInvariant(deal, contract, prefix, claimingSide).invariant) return i;
  }
  return null;
}

/**
 * The claim boundary Analyze already computed and cached for this board, if
 * a current-version analysis exists — exported so rehearsal.ts's
 * createRehearsal can reuse it instead of re-running deriveClaimBoundary's
 * DD solve walk from scratch on every "Play From Here" launch. Returns
 * `undefined` (never `null`, which is claimedAtPly's own valid "no claim"
 * answer) when there is no usable cache and the caller must derive fresh.
 */
export function cachedClaimBoundary(boardId: number): number | null | undefined {
  const cached = stmtGetAnalysis.get(boardId) as { version: number; core: string } | undefined;
  if (!cached || cached.version !== ANALYZE_VERSION) return undefined;
  return (JSON.parse(cached.core) as AnalysisCore).claimedAtPly;
}

/** substitute — never append — my counterfactual score into the real field (see boardFieldRows) */
function substitutePct(scores: number[], myIndex: number, myScore: number): number {
  const next = [...scores];
  next[myIndex] = myScore;
  return matchpoints(next)[myIndex].pct;
}

/**
 * The matchpoint layer, recomputed at SERVE time against the LIVE field.
 * The cache stores engine facts — the DD trace, the sampled verdicts, the
 * counterfactual SCORES — none of which depend on who else has played the
 * board; everything measured in matchpoints is a cheap pure function of the
 * field's score list, so it is served fresh instead. That keeps the whole
 * response consistent with itself (play and bid moments measured on ONE
 * field) and with the Result's live field table one tap away, and a page
 * refresh picks up tables that finished since the audit first ran. (The
 * first design froze the field into the cache: equally consistent, but
 * permanently stale — the receipts' percentage and the rail would disagree
 * with the Result forever once the field grew.)
 *
 * Stage 3's floor SELECTION — which plies bought the expensive sampled
 * verdict — is decided against whatever field existed when this analysis
 * was first computed, not today's; a growing field can leave a ply
 * under-judged here. That gap does NOT stay open, though:
 * getBoardAnalysis calls backfillDriftedPlies immediately after this
 * function runs, using the mpCost this function just refreshed, so a ply
 * that has since drifted over MOMENT_FLOOR gets its stage-3 solve there
 * rather than being served unjudged. Mutates the parsed copies, never the
 * cache row (backfillDriftedPlies is the one that persists, and only when
 * it actually changed something).
 */
function refreshMatchpointLayer(t: TournamentRow, b: GameBoard, core: AnalysisCore, par: AnalysisPar | null): void {
  const rows = boardFieldRows(t.id, b.row.board_no);
  const myIndex = rows.findIndex((r) => r.user_id === b.row.user_id);
  const scores = rows.map((r) => r.score_ns ?? 0);
  const singleField = rows.length <= 1 || myIndex < 0;
  core.fieldScores = scores;
  core.myIndex = myIndex;
  core.singleField = singleField;
  core.actualPct = singleField ? null : matchpoints(scores)[myIndex].pct;
  for (const p of core.plies) {
    p.cfPct = singleField ? null : substitutePct(scores, myIndex, p.cfScoreNS);
    p.mpCost = p.cfPct === null || core.actualPct === null ? null : p.cfPct - core.actualPct;
  }
  for (const c of par?.calls ?? []) {
    if (!c.cf) continue;
    c.cf.cfPct = singleField ? null : substitutePct(scores, myIndex, c.cf.scoreNS);
    c.cf.mpGain = c.cf.cfPct === null || core.actualPct === null ? null : c.cf.cfPct - core.actualPct;
  }
}

/**
 * Stage 3's per-candidate findability verdict, extracted so computeCore's
 * first pass and backfillDriftedPlies' serve-time second chance (below) call
 * exactly the same judging logic — the two must never diverge on what makes
 * a card excused. Returns null for an EXCUSED candidate (the sampled engine
 * would also have played the card, deficit <= 0); the caller drops it from
 * `plies` entirely rather than keeping a null verdict, so a dropped
 * candidate is never re-attempted on a later serve.
 */
async function sampleFindability(
  t: TournamentRow,
  b: GameBoard,
  deal: Deal,
  contract: Contract,
  p: PlyAnalysis,
): Promise<PlyAnalysis['sampled']> {
  const { legal, totals } = await scoreCardsSampled(deal, contract, b.plays.slice(0, p.ply), {
    k: ANALYZE_K,
    // per-ply namespace: two opens of the same board must sample the same
    // layouts or the cache and a recompute would disagree (same
    // duplicate-fairness argument as mcDecisionSeed, different namespace)
    seed: `${t.seed}:analyze:${b.row.board_no}:${p.ply}`,
    dealer: deal.dealer,
    calls: b.calls,
    useAuction: true,
    priority: 'background',
  });
  let bestCard = legal[0];
  for (const c of legal) if ((totals.get(c) ?? 0) > (totals.get(bestCard) ?? 0)) bestCard = c;
  const deficit = ((totals.get(bestCard) ?? 0) - (totals.get(p.card) ?? 0)) / ANALYZE_K;
  if (deficit <= 0) return null;
  return { bestCard, deficit, grade: gradeFromDeficit(deficit) };
}

/**
 * The serve-time second chance for the one thing refreshMatchpointLayer's
 * field refresh cannot fix on its own: a candidate whose floor SELECTION ran
 * against a thinner field at first-open than exists now. Called from
 * getBoardAnalysis right after refreshMatchpointLayer, so every ply's
 * mpCost is already today's — any still-unjudged ply (sampled === null,
 * meaning it never cleared the floor at compute time, NOT an excused one:
 * those are already gone from `plies`, see computeCore) whose refreshed
 * cost clears MOMENT_FLOOR now gets the one stage-3 solve it was denied
 * before, via the exact same sampleFindability computeCore itself calls.
 * Mutates core.plies in place (a genuine verdict is attached; a candidate
 * that turns out excused is dropped, matching computeCore's own rule, so it
 * is never re-attempted on a future serve) and returns whether anything
 * changed, so the caller only re-persists the cache row when it did.
 *
 * This closes the gap refreshMatchpointLayer's doc comment used to describe
 * as permanent ("assembleMoments only promotes judged plies... the client
 * captions the drifted case honestly"): that caption (Analyze.tsx's
 * captionFor, the "field has shifted since the audit ran" branch) still
 * exists for a genuinely unreachable-in-practice residual — it compares a
 * ROUNDED matchpoint figure for display, while this backfill (like
 * computeCore) compares the raw, unrounded mpCost, so a candidate sitting
 * exactly on the rounding boundary can still read as "cleared" to a reader
 * without having cleared the raw gate here.
 */
async function backfillDriftedPlies(t: TournamentRow, b: GameBoard, core: AnalysisCore): Promise<boolean> {
  if (!core.contract) return false;
  const excusedOnBackfill: number[] = [];
  let changed = false;
  for (const p of core.plies) {
    if (p.sampled !== null) continue;
    if (p.mpCost === null || p.mpCost < MOMENT_FLOOR) continue;
    const sampled = await sampleFindability(t, b, b.deal, core.contract, p);
    changed = true;
    if (sampled === null) excusedOnBackfill.push(p.ply);
    else p.sampled = sampled;
  }
  if (excusedOnBackfill.length) core.plies = core.plies.filter((p) => !excusedOnBackfill.includes(p.ply));
  return changed;
}

/** Stages 1–3. `b` must be a finished board belonging to the analysis's viewer. */
async function computeCore(t: TournamentRow, b: GameBoard): Promise<AnalysisCore> {
  const deal = b.deal;
  const rows = boardFieldRows(t.id, b.row.board_no);
  const myIndex = rows.findIndex((r) => r.user_id === b.row.user_id);
  const scores = rows.map((r) => r.score_ns ?? 0);
  const singleField = rows.length <= 1 || myIndex < 0;
  const actualPct = singleField ? null : matchpoints(scores)[myIndex].pct;

  if (!b.contract) {
    // passed out — no play to walk; the auction lens still applies (stage 4)
    return {
      boardNo: b.row.board_no,
      contract: null,
      claimedAtPly: null,
      singleField,
      fieldScores: scores,
      myIndex,
      actualPct,
      ddTricks: null,
      plies: [],
    };
  }
  const contract = b.contract;

  // The grading boundary: cards from the claim on were played BY THE SERVER
  // for both sides (resolveClaim, true-DD at every difficulty) — grading them
  // against the human would be a false statement, and the robots were
  // silently upgraded there so the DD deltas aren't comparable anyway.
  const claimedAtPly = b.row.claimed_at_ply ?? (await deriveClaimBoundary(deal, contract, b.plays, claimRule(t)));
  const boundary = claimedAtPly ?? b.plays.length;

  // Stage 1 — the DD trace: one AnalysePlayPBN call for the whole play.
  const ddTricks = await analysePlayTricks(deal, contract, b.plays, 'background');
  const actualTricks = b.row.tricks_declarer ?? ddTricks[ddTricks.length - 1];
  const declaring = humanSideDeclares(contract);

  const plies: PlyAnalysis[] = [];
  for (let ply = 0; ply < Math.min(b.plays.length, ddTricks.length - 1, boundary); ply++) {
    const prefix = b.plays.slice(0, ply);
    const ps = playState(deal, contract, prefix);
    // the same boundary advanceRobots plays by: the human plays their whole
    // side when N-S declares (dummy included, both flip orientations) and
    // South alone on defence — robot partner North is never graded
    if (!humanControls(ps.handToPlay, contract)) continue;
    if (legalCards(deal, ps).length <= 1) continue; // forced — not a decision
    const rawDelta = ddTricks[ply + 1] - ddTricks[ply]; // declarer-perspective
    const ddLoss = declaring ? -rawDelta : rawDelta;
    if (ddLoss <= 0) continue; // not an error by this side

    const cfTricksDeclarer = Math.max(0, Math.min(13, actualTricks + (declaring ? ddLoss : -ddLoss)));
    const cfScoreNS = boardScoreNS(contract, deal.vul, cfTricksDeclarer);
    const cfPct = singleField ? null : substitutePct(scores, myIndex, cfScoreNS);
    const mpCost = cfPct === null || actualPct === null ? null : cfPct - actualPct;

    plies.push({
      ply,
      trick: ps.completedTricks.length + 1,
      seat: ps.handToPlay,
      card: b.plays[ply],
      ddLoss,
      cfTricksDeclarer,
      cfScoreNS,
      cfPct,
      mpCost,
      sampled: null,
    });
  }

  // Stage 3 — the findability verdict, ONLY for candidates that cleared the
  // floor (stage 2 is the filter: k solves of different deals per candidate
  // pay near-cold price each). In a single field there is no matchpoint axis,
  // so the gate substitutes the DD trick loss itself. A candidate the sampled
  // engine would ALSO have played (deficit <= 0) is dropped from the result
  // entirely rather than flagged — that trick only ever existed for a trace
  // that can see all 52 cards, nobody at the table had a real shot at it, and
  // a well-played board should come back with nothing to show for it rather
  // than a row arguing the player's own innocence. Candidates that DON'T
  // clear the floor here can still be judged later — see backfillDriftedPlies,
  // called from getBoardAnalysis on every serve — so this first pass is a
  // COST-SAVING filter (skip the expensive solve when the field obviously
  // won't reward it), not the only chance a candidate gets.
  const excusedPlies = new Set<number>();
  for (const p of plies) {
    const clears = p.mpCost === null ? p.ddLoss >= 1 : p.mpCost >= MOMENT_FLOOR;
    if (!clears) continue;
    const sampled = await sampleFindability(t, b, deal, contract, p);
    if (sampled === null) {
      excusedPlies.add(p.ply);
      continue;
    }
    p.sampled = sampled;
  }
  const judgedPlies = excusedPlies.size ? plies.filter((p) => !excusedPlies.has(p.ply)) : plies;

  return {
    boardNo: b.row.board_no,
    contract,
    claimedAtPly,
    singleField,
    fieldScores: scores,
    myIndex,
    actualPct,
    ddTricks,
    plies: judgedPlies,
  };
}

/**
 * Stage 4 — par + counterfactual auctions (the overview lens only). The
 * matchpoint figures computed here are compute-time placeholders: what the
 * cache keeps are the engine facts (the re-run auctions and their SCORES),
 * and refreshMatchpointLayer re-measures them against the live field on
 * every serve, so play and bid moments always share one field.
 */
async function computePar(_t: TournamentRow, b: GameBoard, core: AnalysisCore): Promise<AnalysisPar> {
  const deal = b.deal;
  const { fieldScores: scores, myIndex } = core;

  const table = await calcDdTable(deal, 'background');
  const par = await dealerParFor(table, deal.dealer, deal.vul, 'background');

  const calls: CallAnalysis[] = [];
  let evalIdx = 0;
  for (let i = 0; i < b.calls.length && evalIdx < b.bidEvals.length; i++) {
    if ((deal.dealer + i) % 4 !== HUMAN_SEAT) continue; // not the human's call
    const ev = b.bidEvals[evalIdx++];
    let cf: CallAnalysis['cf'] = null;
    if (ev.bestCall !== b.calls[i]) {
      // Re-run the auction from the substituted call: the shared bidder,
      // pure argmax (no opts — deterministic, difficulty-blind), every seat
      // including the human's own later calls. The app's OPINION of what
      // would have happened, not a fact — the client says so.
      const cfCalls = [...b.calls.slice(0, i), ev.bestCall];
      let safety = 40;
      while (!auctionState(deal.dealer, cfCalls).isOver && safety-- > 0) {
        cfCalls.push(bidder.chooseCall(deal, cfCalls));
      }
      const cfContract = finalContract(deal.dealer, cfCalls);
      const ddTricks = cfContract ? ddTableTricks(table, cfContract.strain, cfContract.declarer) : null;
      const scoreNS = cfContract ? boardScoreNS(cfContract, deal.vul, ddTricks!) : 0;
      const cfPct = core.singleField ? null : substitutePct(scores, myIndex, scoreNS);
      cf = {
        calls: cfCalls,
        contract: cfContract,
        contractLabel: cfContract ? contractLabel(cfContract, ddTricks ?? undefined) : 'Passed out',
        ddTricks,
        scoreNS,
        cfPct,
        mpGain: cfPct === null || core.actualPct === null ? null : cfPct - core.actualPct,
      };
    }
    calls.push({ callIndex: i, call: b.calls[i], bestCall: ev.bestCall, cf });
  }

  return { parScore: par.score, parContracts: par.contracts, calls };
}

/**
 * Serve-time moment assembly — a pure function of the cached pieces, so bid
 * moments appear once the par stage exists without invalidating core.
 * core.plies never carries an excused candidate (computeCore drops those
 * before this runs), so every row assembled here is a genuine, chargeable
 * fault — a board played to the limit of what was findable from the seat
 * comes back with an empty ledger, not a list of forgiven costs. Ranking is
 * by cost, capped at MAX_MOMENTS with the overflow counted.
 */
export function assembleMoments(core: AnalysisCore, par: AnalysisPar | null): { moments: Moment[]; setAside: number } {
  const all: Moment[] = [];
  for (const p of core.plies) {
    if (p.sampled === null || p.mpCost === null || p.mpCost < MOMENT_FLOOR) continue;
    all.push({
      kind: 'play',
      ply: p.ply,
      trick: p.trick,
      card: p.card,
      grade: p.sampled.grade,
      mpCost: p.mpCost,
    });
  }
  for (const c of par?.calls ?? []) {
    if (c.cf?.mpGain != null && c.cf.mpGain >= MOMENT_FLOOR) {
      all.push({ kind: 'bid', callIndex: c.callIndex, call: c.call, mpCost: c.cf.mpGain });
    }
  }
  all.sort((a, b) => b.mpCost - a.mpCost);
  return { moments: all.slice(0, MAX_MOMENTS), setAside: Math.max(0, all.length - MAX_MOMENTS) };
}

/**
 * The endpoint's whole job: cache-first analysis of a finished board.
 * Computed on the FIRST open (never on completion — most boards are never
 * analyzed) and cached; `wantPar` backfills stage 4 into an existing row
 * without recomputing core. A version mismatch recomputes everything.
 *
 * Two backfills run on every serve, cached row or fresh: `wantPar` above,
 * and backfillDriftedPlies below for stage 3's own floor selection — a ply
 * that was under MOMENT_FLOOR when this analysis was first computed but
 * whose cost has since drifted over it (the field grew) gets its one
 * stage-3 solve here rather than staying unjudged forever, and the result
 * is written back so no later serve repeats it.
 */
export async function getBoardAnalysis(t: TournamentRow, b: GameBoard, wantPar: boolean): Promise<AnalysisView> {
  const cached = stmtGetAnalysis.get(b.row.id) as { version: number; core: string; par: string | null } | undefined;

  let core: AnalysisCore;
  let par: AnalysisPar | null = null;

  if (cached && cached.version === ANALYZE_VERSION) {
    core = JSON.parse(cached.core);
    par = cached.par ? JSON.parse(cached.par) : null;
    if (wantPar && !par) {
      par = await computePar(t, b, core);
      stmtPutPar.run(JSON.stringify(par), b.row.id);
    }
  } else {
    core = await computeCore(t, b);
    par = wantPar ? await computePar(t, b, core) : null;
    stmtPutAnalysis.run(b.row.id, ANALYZE_VERSION, JSON.stringify(core), par ? JSON.stringify(par) : null);
  }

  // serve-time: measure everything against today's field, then give any
  // newly-over-the-floor ply its stage-3 verdict, then assemble moments
  // from those fresh figures
  refreshMatchpointLayer(t, b, core, par);
  if (await backfillDriftedPlies(t, b, core)) {
    stmtPutAnalysis.run(b.row.id, ANALYZE_VERSION, JSON.stringify(core), par ? JSON.stringify(par) : null);
  }
  const { moments, setAside } = assembleMoments(core, par);
  return { ...core, version: ANALYZE_VERSION, moments, setAside, par, momentFloor: MOMENT_FLOOR };
}
