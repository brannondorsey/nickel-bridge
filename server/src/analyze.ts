import {
  ddTableTricks,
  analysePlayTricks,
  calcDdTable,
  dealerParFor,
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
import { TournamentRow, db } from './db.js';
import { GameBoard, HUMAN_SEAT, bidder, boardFieldRows, humanControls } from './game.js';

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
 *          the player's own seat. High cost with no fault is shown and
 *          explicitly excused, never charged.
 *
 * Stage order is load-bearing: DD is the cheap filter, sampled DD the
 * expensive verdict (k full solves of DIFFERENT deals per candidate — no
 * shared transposition table), so the verdict only ever runs on candidates
 * that already cleared the matchpoint floor. Stage 4 (par + counterfactual
 * auctions, CalcDDTablePBN at p90 ~576ms) runs only when a lens that shows it
 * is opened, and is cached separately for the same reason.
 *
 * Everything here is a pure, seeded function of the finished board plus the
 * field rows, dispatched at 'background' priority (a live card-play solve
 * beats a report loading; STARVATION_PROMOTE_MS bounds the wait). The cache
 * (board_analyses, see db.ts) and the screen are therefore the same claim
 * made twice — a recompute is byte-identical until ANALYZE_VERSION bumps.
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
 * The gate on the moments ledger, in matchpoint percentage points. Fields
 * here are small — one place in a five-player field is 25 points — so 10 is
 * roughly "half a place". THE one number to move if the screen starts
 * nagging; calibrate against production the way FULL_TILT was (a read-only
 * sweep counting moments per board at each candidate floor) and record the
 * date and n when you do.
 */
export const MOMENT_FLOOR = 10;

/** Ledger rows shown — Chess.com's Key Moments shape: a handful of turning
 *  points beats a narration. Overflow is counted and stated, never silent. */
export const MAX_MOMENTS = 5;

/**
 * Cache key epoch. Bump on ANY deliberate robot change (invariant 1's list),
 * any constant above, a grade-band change, or a stage-3 scoring change — a
 * cached analysis computed against different robots is a stale accusation.
 */
export const ANALYZE_VERSION = 2; // 2: core carries the frozen field snapshot par is computed against

export type CardGrade = 0 | 1 | 2 | 3;

/**
 * Findability grade from the sampled verdict's average trick deficit —
 * (bestTotal − playedTotal) / k, i.e. how many tricks the played card gave up
 * per sampled layout, judged from the player's own seat. 0 deficit means the
 * engine's own pick (excused, grade 3); the bands below are judgement values
 * (ship on judgement, calibrate on data — see MOMENT_FLOOR). Changing them is
 * an ANALYZE_VERSION bump.
 */
export function gradeFromDeficit(deficit: number): { excused: boolean; grade: CardGrade } {
  if (deficit <= 0) return { excused: true, grade: 3 };
  if (deficit < 0.5) return { excused: false, grade: 2 };
  if (deficit < 1.5) return { excused: false, grade: 1 };
  return { excused: false, grade: 0 };
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
  /** stage-3 findability — only for candidates that cleared the floor */
  sampled: {
    /** the card the sampled engine plays from the player's seat */
    bestCard: Card;
    /** average tricks the played card gave up across the k sampled layouts */
    deficit: number;
    excused: boolean;
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
   * The field this analysis was computed against, FROZEN at first compute:
   * the board's NS scores in boardFieldRows order, and this player's index in
   * them. Stage 4's later backfill substitutes into THIS snapshot rather than
   * re-querying — the field can grow between a play-lens open and a later
   * crossing-lens open, and a bid moment's mpGain measured against a
   * different field size than the play moments' mpCost would be ranked
   * against them as if comparable. One snapshot per analysis is also what
   * keeps the cache deterministic (the caveat that a board "can be worth a
   * different number next week" is stated copy, not something the backfill
   * quietly does piecemeal).
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
  excused?: boolean;
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
 * node, does either side have 100% of the remaining tricks double-dummy? DDS
 * is deterministic, so this finds precisely the ply where the live game
 * claimed (or none). Costs one solve per decision node once, then cached.
 */
async function deriveClaimBoundary(deal: Deal, contract: Contract, plays: Card[]): Promise<number | null> {
  for (let i = 0; i < plays.length; i++) {
    const prefix = plays.slice(0, i);
    const ps = playState(deal, contract, prefix);
    if (ps.isOver) return null;
    if (legalCards(deal, ps).length <= 1) continue;
    const solve = await solveFutureTricks(deal, contract, prefix, 'background');
    const remaining = 13 - ps.completedTricks.length;
    if (solve.bestScore === remaining || solve.bestScore === 0) return i;
  }
  return null;
}

/** substitute — never append — my counterfactual score into the real field (see boardFieldRows) */
function substitutePct(scores: number[], myIndex: number, myScore: number): number {
  const next = [...scores];
  next[myIndex] = myScore;
  return matchpoints(next)[myIndex].pct;
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
  const claimedAtPly = b.row.claimed_at_ply ?? (await deriveClaimBoundary(deal, contract, b.plays));
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
  // so the gate substitutes the DD trick loss itself.
  for (const p of plies) {
    const clears = p.mpCost === null ? p.ddLoss >= 1 : p.mpCost >= MOMENT_FLOOR;
    if (!clears) continue;
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
    const { excused, grade } = gradeFromDeficit(deficit);
    p.sampled = { bestCard, deficit, excused, grade };
  }

  return {
    boardNo: b.row.board_no,
    contract,
    claimedAtPly,
    singleField,
    fieldScores: scores,
    myIndex,
    actualPct,
    ddTricks,
    plies,
  };
}

/**
 * Stage 4 — par + counterfactual auctions (the crossing/auction lenses only).
 * Substitutes into core's FROZEN field snapshot, never a fresh query — see
 * AnalysisCore.fieldScores for why (a backfill against a grown field would
 * rank bid moments against play moments measured on different fields).
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
 * Charged and excused moments both list (an excused cost is SHOWN and argued
 * for the player — that's what makes the screen trustworthy); ranking is by
 * cost, capped at MAX_MOMENTS with the overflow counted.
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
      excused: p.sampled.excused,
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

  const { moments, setAside } = assembleMoments(core, par);
  return { ...core, version: ANALYZE_VERSION, moments, setAside, par };
}
