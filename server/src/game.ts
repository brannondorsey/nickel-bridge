import {
  BidEvaluation,
  Bidder,
  DdSolve,
  MC_SAMPLES,
  PLAY_NOISE,
  SolvePriority,
  bidDecisionSeed,
  chooseCard,
  chooseCardSampled,
  isOutcomeInvariant,
  loadPolicyModel,
  mcDecisionSeed,
  pickFromSolve,
  solveFutureTricks,
} from '@bridge/ai';
import {
  BidMeaning,
  Call,
  Card,
  Contract,
  Deal,
  Seat,
  auctionState,
  boardScoreNS,
  callName,
  contractLabel,
  dealBoard,
  explainBid,
  finalContract,
  hcp,
  legalCalls,
  legalCards,
  matchpoints,
  partnerOf,
  PlayState,
  playState,
  scoreBreakdown,
} from '@bridge/core';
import { BOARDS_PER_TOURNAMENT, BoardRow, TournamentRow, aiTieRank, db } from './db.js';
import {
  QuizGenerationContext,
  hasPendingQuiz,
  maybeGenerateQuiz,
  pendingQuizView,
  quizReportCard,
  recordQuizAnswer,
} from './quiz.js';
import { boardDifficulty, claimRule, getTournament, recomputeElo } from './tournaments.js';

export const HUMAN_SEAT: Seat = 2; // South — exported for analyze.ts's grading boundary
export { BOARDS_PER_TOURNAMENT };

// Exported for the benchmark AI personas (ai-players.ts), which bid their own
// seat through the same model instance the robots use.
export const bidder = new Bidder(loadPolicyModel((process.env.AI_MODEL as 'sl' | 'rl-fsp') ?? 'sl'));

const stmtBoard = db.prepare(`SELECT * FROM boards WHERE tournament_id = ? AND user_id = ? AND board_no = ?`);
const stmtCreateBoard = db.prepare(
  `INSERT INTO boards (tournament_id, user_id, board_no) VALUES (?, ?, ?) RETURNING *`,
);
// Scoped to full row identity, not bare id: SQLite reuses rowids after
// deletes, so a request that held a GameBoard across an await while demo
// mode's reset wiped and reseeded the database could otherwise UPDATE a
// recycled id belonging to a different user's board. With the full scope the
// stale write matches nothing and drops harmlessly.
const stmtSaveBoard = db.prepare(
  `UPDATE boards SET state = ?, calls = ?, plays = ?, bid_evals = ?, contract = ?, tricks_declarer = ?, score_ns = ?, claimed_at_ply = ?, updated_at = unixepoch()
   WHERE id = ? AND tournament_id = ? AND user_id = ?`,
);
const stmtBoardResults = db.prepare(
  `SELECT b.*, u.handle AS user_handle, u.kind AS user_kind, u.google_id AS user_google
   FROM boards b JOIN users u ON u.id = b.user_id
   WHERE b.tournament_id = ? AND b.board_no = ? AND b.state = 'done' ORDER BY b.updated_at`,
);
// Whether a board's owner is a benchmark AI persona — those completions never
// trigger the Elo replay: personas are unrated, and the replay's inputs are
// matchpointed among humans only (eloParticipants in tournaments.ts), so a
// persona's rows can't change them.
const stmtUserKind = db.prepare(`SELECT kind FROM users WHERE id = ?`);
function isAiUser(userId: number): boolean {
  return (stmtUserKind.get(userId) as { kind: 'human' | 'ai' } | undefined)?.kind === 'ai';
}
// "Settled tricks" on the settings gate (users.auto_claim): does this player
// want the server to fast-play a tail they have no decisions left in, or to
// play it out themselves? Missing row or column ⇒ true, matching the schema
// default and the behaviour every account had before the setting existed.
const stmtAutoClaim = db.prepare(`SELECT auto_claim FROM users WHERE id = ?`);
function wantsAutoClaim(userId: number): boolean {
  return (stmtAutoClaim.get(userId) as { auto_claim: number } | undefined)?.auto_claim !== 0;
}

export interface GameBoard {
  row: BoardRow;
  /** the owning tournament — carries the seed and robot difficulty for this board */
  tournament: TournamentRow;
  deal: Deal;
  calls: Call[];
  plays: Card[];
  bidEvals: (BidEvaluation & { call: Call; bestMeaning?: BidMeaning | null })[];
  contract: Contract | null;
  /**
   * Set by advanceRobots when this request resolved a laydown claim.
   * Transient — never persisted (loadBoard builds a fresh GameBoard per
   * request, so it always starts unset) and never added to the boards table.
   */
  claimed?: boolean;
}

/**
 * The row-derived fields of a GameBoard, parsed from a freshly-read row. The
 * single source of truth for "what a board row hydrates into": loadBoard
 * spreads it into a new GameBoard and refresh() assigns it over an existing
 * one, so the two can never drift apart if GameBoard grows another
 * row-derived field — add it to the Pick and both call sites get it.
 */
function rowFields(row: BoardRow): Pick<GameBoard, 'row' | 'calls' | 'plays' | 'bidEvals' | 'contract'> {
  return {
    row,
    calls: JSON.parse(row.calls),
    plays: JSON.parse(row.plays),
    bidEvals: JSON.parse(row.bid_evals),
    contract: row.contract ? JSON.parse(row.contract) : null,
  };
}

export function loadBoard(t: TournamentRow, userId: number, boardNo: number, createIfMissing: boolean): GameBoard | null {
  let row = stmtBoard.get(t.id, userId, boardNo) as BoardRow | undefined;
  if (!row) {
    if (!createIfMissing) return null;
    row = stmtCreateBoard.get(t.id, userId, boardNo) as BoardRow;
  }
  return {
    ...rowFields(row),
    tournament: t,
    deal: dealBoard(t.seed, boardNo),
  };
}

// Scoped to full row identity, matching stmtSaveBoard: a bare `id` lookup
// could otherwise silently load a DIFFERENT board (SQLite reuses rowids
// after deletes — see stmtSaveBoard's comment above) into a GameBoard whose
// tournament/user identity no longer matches, if e.g. demo mode's reset wipes
// and reseeds the database while this request is parked on an await.
const stmtBoardById = db.prepare(`SELECT * FROM boards WHERE id = ? AND tournament_id = ? AND user_id = ?`);

/**
 * Per-board in-process serialization for submitCall/submitPlay/ensureAdvanced
 * — every entry point that can mutate a board. Each loads a board, runs real
 * async work (advanceRobots — DDS solves / model inference, potentially
 * routed through the dd-pool.ts worker_threads pool), then save()s the
 * mutated copy back — a read-modify-write race if two requests for the SAME
 * board (double-tap, a duplicated tab's plain GET racing another tab's
 * submit, a client retry) overlap across that await. This is a
 * single-machine SQLite deployment (see CLAUDE.md "Deployment shape" — no
 * horizontal scaling), so an in-process queue is sufficient: chain each
 * board's requests onto a promise so a second request's critical section
 * only starts once the first's save() has landed, instead of racing it.
 * Keyed by full row identity, matching stmtSaveBoard's WHERE clause above.
 */
const boardLocks = new Map<string, Promise<unknown>>();

function boardKey(row: BoardRow): string {
  return `${row.tournament_id}:${row.user_id}:${row.board_no}`;
}

function withBoardLock<T>(row: BoardRow, fn: () => Promise<T>): Promise<T> {
  const key = boardKey(row);
  const prior = boardLocks.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn); // run regardless of whether the prior request threw
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  boardLocks.set(key, settled);
  // Bound the map to boards with in-flight or queued work: drop this
  // board's entry once it settles, unless a later request already chained
  // onto it (in which case that request owns the key now).
  void settled.then(() => {
    if (boardLocks.get(key) === settled) boardLocks.delete(key);
  });
  return run;
}

/**
 * Re-read this board's row from SQLite into `b`, in place. Called at the top
 * of submitCall/submitPlay/ensureAdvanced inside withBoardLock so a request
 * that queued behind another sees that request's committed write instead of
 * the stale snapshot it read (via loadBoard) before the race even began —
 * the second of two racing requests then naturally re-hits the ordinary
 * "not your turn" / "not in bidding phase" checks below, the same as a
 * genuinely late duplicate would, instead of clobbering the first request's
 * save(). Scoped by full identity (see stmtBoardById above): if the row is
 * gone or its identity no longer matches — a demo-reset wipe landing mid-race
 * — fail loudly instead of silently adopting a stale/wrong board. Hydrates
 * via the same rowFields() as loadBoard; the deterministic/static deal and
 * tournament are deliberately left untouched.
 */
function refresh(b: GameBoard): void {
  const row = stmtBoardById.get(b.row.id, b.row.tournament_id, b.row.user_id) as BoardRow | undefined;
  if (!row) throw httpError(409, 'board no longer exists');
  Object.assign(b, rowFields(row));
}

function save(b: GameBoard): void {
  stmtSaveBoard.run(
    b.row.state,
    JSON.stringify(b.calls),
    JSON.stringify(b.plays),
    JSON.stringify(b.bidEvals),
    b.contract ? JSON.stringify(b.contract) : null,
    b.row.tricks_declarer,
    b.row.score_ns,
    b.row.claimed_at_ply,
    b.row.id,
    b.row.tournament_id,
    b.row.user_id,
  );
}

/** function boundary defeats TS narrowing: advanceRobots mutates row.state */
function boardDone(row: BoardRow): boolean {
  return row.state === 'done';
}

/**
 * Does the human play this hand? The human plays their whole side: South
 * always, and North whenever N-S is the declaring side (South declaring →
 * South + dummy North; North declaring → the board flips and the human runs
 * partner's hand). Defending, the human plays only South. Exported for
 * analyze.ts, which must grade exactly the cards this says the human chose —
 * not "South's cards" — in both flip orientations.
 */
export function humanControls(hand: Seat, contract: Contract): boolean {
  if (hand === HUMAN_SEAT) return true;
  return hand === partnerOf(HUMAN_SEAT) && contract.declarer % 2 === HUMAN_SEAT % 2;
}

/**
 * Which seat's cards the human is actually controlling for this contract, and
 * which seat is dummy — the "hand-flip subtlety": when the human's partner
 * declares, control flips so the human plays THAT hand instead of sitting as
 * a pure spectator dummy. `boardView` and the Pop-Up Quiz trigger-check
 * (`advanceRobots`) both call this rather than each re-deriving it — that
 * duplication is exactly the bug class this helper exists to close off.
 */
export function playingSeatFor(contract: Contract): { playingSeat: Seat; dummySeat: Seat } {
  const flipped = contract.declarer === partnerOf(HUMAN_SEAT);
  return { playingSeat: flipped ? contract.declarer : HUMAN_SEAT, dummySeat: partnerOf(contract.declarer) };
}

function finishBoard(b: GameBoard): void {
  if (b.contract) {
    const ps = playState(b.deal, b.contract, b.plays);
    b.row.tricks_declarer = ps.declarerTricks;
    b.row.score_ns = boardScoreNS(b.contract, b.deal.vul, ps.declarerTricks);
  } else {
    b.row.tricks_declarer = null;
    b.row.score_ns = 0; // passed out
  }
  b.row.state = 'done';
}

/**
 * Advance all robot actions until it's the human's turn or the board is over.
 * Deterministic: model argmax bidding, double-dummy-optimal card play.
 *
 * `priority` forwards to every DD pool solve this call makes (default
 * 'interactive' — every real human request). bot-play.ts's shared board-play
 * loop (the benchmark AI personas, demo seeding, demo exhibit replay) passes
 * 'background' so a concurrent human's own request jumps the queue for the
 * next free DD worker — see packages/ai/src/dd-pool.ts's doc comment for why.
 */
export async function advanceRobots(b: GameBoard, priority: SolvePriority = 'interactive'): Promise<void> {
  // Read once per request rather than at every gate node: it is a tiny
  // prepared read, but the gate can be reached several times in one call and
  // a preference cannot change mid-request.
  let autoClaim: boolean | null = null;
  // Pop-Up Quiz: how many completed tricks this CALL has already scanned for
  // a trigger. Reinitialized every call, unlike hasPendingQuiz below (checked
  // first, on every iteration) which is the authoritative, cross-call gate —
  // see quiz.ts's doc comments and CLAUDE.md's "Pop-Up Quiz" section for why
  // both are needed.
  let quizCheckedThroughTrick: number | null = null;
  for (;;) {
    if (b.row.state === 'bidding') {
      const auction = auctionState(b.deal.dealer, b.calls);
      if (auction.isOver) {
        b.contract = finalContract(b.deal.dealer, b.calls);
        if (!b.contract) {
          finishBoard(b);
          return;
        }
        b.row.state = 'playing';
        continue;
      }
      if (auction.turn === HUMAN_SEAT) return;
      b.calls.push(
        bidder.chooseCall(b.deal, b.calls, {
          difficulty: boardDifficulty(b.tournament, b.row.board_no),
          seed: bidDecisionSeed(b.tournament.seed, b.row.board_no, b.calls.length),
        }),
      );
      continue;
    }
    if (b.row.state === 'playing') {
      // The authoritative cross-call gate: a pending quiz freezes the board
      // for its whole lifetime, not just within the call that generated it —
      // this is what makes a reload/second-tab/ensureAdvanced call during an
      // unanswered quiz a genuine no-op instead of sailing past it.
      if (hasPendingQuiz(b.row.id)) return;
      const ps = playState(b.deal, b.contract!, b.plays);
      if (quizCheckedThroughTrick === null) quizCheckedThroughTrick = ps.completedTricks.length;
      if (ps.completedTricks.length > quizCheckedThroughTrick) {
        // In practice always exactly one trick per iteration (each loop pass
        // pushes one card, so completedTricks can only ever increment by one
        // between checks) — looped defensively rather than assumed.
        const { playingSeat, dummySeat } = playingSeatFor(b.contract!);
        const quizCtx: QuizGenerationContext = {
          boardId: b.row.id,
          userId: b.row.user_id,
          tournamentKind: b.tournament.kind,
          tournamentSeed: b.tournament.seed,
          boardNo: b.row.board_no,
          claimedAtPly: b.row.claimed_at_ply,
          deal: b.deal,
          contract: b.contract!,
          dealer: b.deal.dealer,
          calls: b.calls,
          plays: b.plays,
        };
        for (let k = quizCheckedThroughTrick + 1; k <= ps.completedTricks.length; k++) {
          if (maybeGenerateQuiz(quizCtx, k, playingSeat, dummySeat)) return; // stop, exactly like a human decision point
        }
        quizCheckedThroughTrick = ps.completedTricks.length;
      }
      if (ps.isOver) {
        finishBoard(b);
        return;
      }
      const legal = legalCards(b.deal, ps);
      if (legal.length > 1) {
        // A forced (single-legal-card) node carries no new branching
        // information for a claim, so we skip the solve there — the next
        // real decision point is checked the following iteration regardless.
        // Under the pessimistic gate that also means a position can BECOME
        // settled at a forced node and the claim wait for the next unforced
        // one, or never fire at all if every remaining node is forced. Both
        // are harmless: a settled position plays out to the identical score,
        // so all that is deferred is the fast-forward. Deferral is safe in
        // general, in fact — settledness is hereditary, so a position that is
        // settled here is still settled at every node below it.
        const solve = await solveFutureTricks(b.deal, b.contract!, b.plays, priority);
        const remainingTricks = 13 - ps.completedTricks.length;
        // Either the side to move (bestScore === remaining) or the defense
        // (bestScore === 0) takes 100% of the remaining tricks double dummy.
        const ddLaydown = solve.bestScore === remainingTricks || solve.bestScore === 0;
        const claimingSide = (
          solve.bestScore === remainingTricks ? ps.handToPlay % 2 : (ps.handToPlay + 1) % 2
        ) as 0 | 1;
        // The DD solve is the cheap NECESSARY condition, and we have already
        // paid for it at this node. It is not a SUFFICIENT one: a double-dummy
        // laydown is only settled while everybody keeps playing correctly, and
        // fast-forwarding it means the server quietly making whatever choices
        // remain — including the human's own, and including the endgame slips
        // a weak-tier robot would really have made. So on tournaments carrying
        // 'pessimistic' the position must also be OUTCOME-INVARIANT: no legal
        // card by any of the four seats, in any continuation, can change the
        // result (packages/ai/src/claim.ts).
        //
        // 'optimistic' tournaments keep the old gate AND claim for everyone,
        // ignoring the player's "Settled tricks" setting. Both halves are the
        // same rule: on those boards a claim genuinely changes the outcome, so
        // re-gating one — whether by the rule change or by a checkbox — would
        // change its replay and hand two players on the identical board
        // different games. Invariant 1 forbids the first and rejected the
        // second. Under 'pessimistic' the setting is free precisely because
        // every legal tail scores the same.
        //
        // The preference is checked BEFORE the search, so a player who has
        // opted out never pays for it.
        const mayClaim =
          ddLaydown &&
          (claimRule(b.tournament) === 'optimistic' ||
            ((autoClaim ??= wantsAutoClaim(b.row.user_id)) &&
              isOutcomeInvariant(b.deal, b.contract!, b.plays, claimingSide).invariant));
        if (mayClaim) {
          b.claimed = true;
          // Persist the boundary: everything from this plays-index on is the
          // server fast-playing the settled tail for both sides — including,
          // when the claim fires on the human's own turn, cards from the
          // human's hand. Analyze must never grade past it (see the
          // claimed_at_ply migration comment in db.ts). At most one claim per
          // board: resolveClaim finishes it.
          b.row.claimed_at_ply = b.plays.length;
          b.plays.push(pickFromSolve(legal, solve));
          // Everything from here to the end of the board is about to be
          // decided by resolveClaim, not played — foreclose the re-entered
          // iteration's quiz-boundary check from scanning the claimed tail
          // for triggers (a trick the server decided unilaterally is not a
          // trick a quiz can fire on). The trick that CAUSED this claim was
          // already correctly checked above, before mayClaim was evaluated,
          // so this only forecloses tricks AFTER it.
          quizCheckedThroughTrick = 13;
          await resolveClaim(b, priority);
          continue;
        }
        if (!humanControls(ps.handToPlay, b.contract!)) {
          b.plays.push(await robotCard(b, ps, legal, solve, priority));
          continue;
        }
        return;
      }
      // Forced node: chooseCard returns the single legal card without a
      // solve — identical at every difficulty.
      if (humanControls(ps.handToPlay, b.contract!)) return;
      b.plays.push(await chooseCard(b.deal, b.contract!, b.plays, priority));
      continue;
    }
    return; // done
  }
}

/**
 * The robot's card at a non-forced, non-claim node. Difficulty is resolved
 * PER BOARD (boardDifficulty): 'perfect' — the legacy value every
 * pre-difficulty tournament resolves to — is byte-for-byte the historical
 * path, pickFromSolve on the true-deal solve advanceRobots already ran for
 * the claim gate. The player-facing tiers use sampled double-dummy play
 * (packages/ai/play-mc.ts) — a pure function of public state + tournament
 * seed, so every player on this board still faces the identical robot
 * (invariant 1); the tier sets K, whether OPPONENTS may infer from the
 * auction (beginner is auction-blind), and — PLAY_NOISE, layered on top of
 * K, orthogonal to belief formation — how often opponents settle for a
 * near-best card instead of the single best one. Robot North exists only as
 * the human's defensive partner (humanControls gives the human every N-S
 * hand when N-S declares), so actor seat 0 gets kPartner, is always
 * auction-aware, and is never subject to PLAY_NOISE (playTopN stays 1);
 * robot E-W — declaring, controlling their dummy, or defending — get the
 * tier's kOpp/auctionAware/playTopN.
 */
async function robotCard(
  b: GameBoard,
  ps: PlayState,
  legal: Card[],
  solve: DdSolve,
  priority: SolvePriority,
): Promise<Card> {
  const difficulty = boardDifficulty(b.tournament, b.row.board_no);
  if (difficulty === 'perfect') return pickFromSolve(legal, solve);
  const dummy = partnerOf(b.contract!.declarer);
  const actor = ps.handToPlay === dummy ? b.contract!.declarer : ps.handToPlay;
  const isPartner = actor === 0;
  const tier = MC_SAMPLES[difficulty];
  return chooseCardSampled(b.deal, b.contract!, b.plays, {
    k: isPartner ? tier.kPartner : tier.kOpp,
    useAuction: isPartner ? true : tier.auctionAware,
    playTopN: isPartner ? 1 : PLAY_NOISE[difficulty].topN,
    seed: mcDecisionSeed(b.tournament.seed, b.row.board_no, b.plays.length),
    dealer: b.deal.dealer,
    calls: b.calls,
    priority,
  });
}

/**
 * Play out every remaining card once a claim fires — true-DD for both sides,
 * at every difficulty.
 *
 * Under the legacy 'optimistic' gate this was the load-bearing half of the
 * guarantee: the position is 100% determined only against best play, so only
 * best play reproduces the score, which is also exactly the complaint against
 * that gate (invariant 1's open question — the tail silently plays the human's
 * remaining decisions, and silently promotes a beginner-tier robot to perfect
 * for the rest of the hand).
 *
 * Under 'pessimistic' the same code needs no such defence, because the gate has
 * already PROVEN that no legal card by any seat can change the result. Every
 * possible tail scores the same, so this one is simply an arbitrary member of a
 * set of provably equivalent tails, kept because it is the cheapest
 * deterministic way to fill in `plays` and because it leaves legacy boards
 * byte-identical. That is what closes the open question for new tournaments —
 * not by teaching the gate about tiers, but by making the tail's contents
 * irrelevant, so a weaker robot has nothing left to be fallible about.
 */
async function resolveClaim(b: GameBoard, priority: SolvePriority): Promise<void> {
  while (!playState(b.deal, b.contract!, b.plays).isOver) {
    b.plays.push(await chooseCard(b.deal, b.contract!, b.plays, priority));
  }
}

export async function submitCall(
  b: GameBoard,
  call: Call,
  priority: SolvePriority = 'interactive',
): Promise<BidEvaluation & { call: Call; bestMeaning: BidMeaning | null }> {
  return withBoardLock(b.row, async () => {
    refresh(b);
    if (b.row.state !== 'bidding') throw httpError(409, 'not in bidding phase');
    const auction = auctionState(b.deal.dealer, b.calls);
    if (auction.isOver || auction.turn !== HUMAN_SEAT) throw httpError(409, 'not your turn');
    if (!legalCalls(auction)[call]) throw httpError(400, 'illegal call');
    const bare = bidder.evaluate(b.deal, b.calls, call);
    // Name the robot's preferred call so the UI can teach, not just score.
    const evaluation = { ...bare, call, bestMeaning: meaningFor(b.deal.dealer, b.calls, bare.bestCall) };
    b.calls.push(call);
    b.bidEvals.push(evaluation);
    await advanceRobots(b, priority);
    save(b);
    // kind === 'standard' excludes exhibit AND rehearsal boards: recomputeElo's
    // own replay already filters to standard tournaments, so calling it here
    // for either would be a wasted full replay-sweep, not a correctness bug —
    // but rehearsals are explicitly uncapped, so skipping the call outright
    // (rather than relying on the replay to no-op) actually matters here.
    if (boardDone(b.row) && !isAiUser(b.row.user_id) && b.tournament.kind === 'standard') recomputeElo();
    return evaluation;
  });
}

export async function submitPlay(b: GameBoard, card: Card, priority: SolvePriority = 'interactive'): Promise<void> {
  return withBoardLock(b.row, async () => {
    refresh(b);
    if (b.row.state !== 'playing') throw httpError(409, 'not in play phase');
    // Defense-in-depth, not the primary enforcement (that's advanceRobots'
    // control flow above) — rejects a stale/racing client whose local state
    // hasn't yet reflected a just-generated pending quiz.
    if (hasPendingQuiz(b.row.id)) throw httpError(409, 'quiz pending — answer it first');
    const ps = playState(b.deal, b.contract!, b.plays);
    if (ps.isOver || !humanControls(ps.handToPlay, b.contract!)) throw httpError(409, 'not your turn');
    if (!legalCards(b.deal, ps).includes(card)) throw httpError(400, 'illegal card');
    b.plays.push(card);
    await advanceRobots(b, priority);
    save(b);
    // see the matching comment in submitCall above
    if (boardDone(b.row) && !isAiUser(b.row.user_id) && b.tournament.kind === 'standard') recomputeElo();
  });
}

/**
 * Answer a pending Pop-Up Quiz and resume play. Mirrors submitPlay/submitCall
 * exactly: refresh, mutate, advanceRobots, save, Elo-check. Recording the
 * answer happens BEFORE advanceRobots is called again, so the cross-call gate
 * (hasPendingQuiz) sees false on this very call and genuinely resumes —
 * picking back up in the same loop toward the next human decision, a claim,
 * the board finishing, or (structurally handled the same way) another quiz
 * further down the board. Correctness of the answer itself is never revealed
 * — boardView's `quiz` field (the board's next pending quiz, if any, or
 * absent) never carries correctAnswer/reasoning.
 */
export async function submitQuizAnswer(
  b: GameBoard,
  quizId: number,
  answer: number[],
  priority: SolvePriority = 'interactive',
): Promise<void> {
  return withBoardLock(b.row, async () => {
    refresh(b);
    recordQuizAnswer(b.row.id, quizId, answer);
    await advanceRobots(b, priority);
    save(b);
    // see the matching comment in submitCall above
    if (boardDone(b.row) && !isAiUser(b.row.user_id) && b.tournament.kind === 'standard') recomputeElo();
  });
}

/**
 * Ensure a fresh board has robots advanced up to the human (dealer may be
 * W/N/E). Called from the plain GET board route, so — unlike submitCall/
 * submitPlay — there's no human decision to validate; but it runs the exact
 * same real async work (advanceRobots) and unconditionally save()s if
 * anything changed, so it's just as vulnerable to the read-modify-write race
 * those two guard against (a duplicated tab's slow GET clobbering a faster
 * tab's committed submitCall/submitPlay with its own stale result). Goes
 * through the same withBoardLock + refresh as submitCall/submitPlay so a
 * queued-behind call re-reads the winner's committed state first — at which
 * point advanceRobots is a no-op (nothing left to advance) instead of
 * overwriting it.
 */
export async function ensureAdvanced(b: GameBoard, priority: SolvePriority = 'interactive'): Promise<void> {
  return withBoardLock(b.row, async () => {
    refresh(b);
    const before = JSON.stringify([b.calls, b.plays, b.row.state]);
    await advanceRobots(b, priority);
    if (JSON.stringify([b.calls, b.plays, b.row.state]) !== before) {
      save(b);
      // see the matching comment in submitCall above
      if (boardDone(b.row) && !isAiUser(b.row.user_id) && b.tournament.kind === 'standard') recomputeElo();
    }
  });
}

function meaningFor(dealer: Seat, callsBefore: Call[], call: Call): BidMeaning | null {
  try {
    return explainBid(dealer, callsBefore, call);
  } catch {
    return null;
  }
}

/** The client-facing view of a board, redacted for the acting user. */
export function boardView(t: TournamentRow, b: GameBoard, viewerElo: number): Record<string, unknown> {
  const deal = b.deal;
  const auction = auctionState(deal.dealer, b.calls);
  const seatNames = ['North', 'East', 'South (you)', 'West'];

  const auctionView = b.calls.map((call, i) => {
    const seat = ((deal.dealer + i) % 4) as Seat;
    return {
      seat,
      call,
      name: callName(call),
      isHuman: seat === HUMAN_SEAT,
      meaning: meaningFor(deal.dealer, b.calls.slice(0, i), call),
    };
  });

  const view: Record<string, unknown> = {
    tournamentId: t.id,
    tournamentName: t.name,
    difficulty: boardDifficulty(t, b.row.board_no),
    boardNo: b.row.board_no,
    totalBoards: BOARDS_PER_TOURNAMENT,
    state: b.row.state,
    dealer: deal.dealer,
    vul: deal.vul,
    seatNames,
    hand: remaining(deal, b.plays, HUMAN_SEAT),
    fullHand: deal.hands[HUMAN_SEAT],
    hcp: hcp(deal.hands[HUMAN_SEAT]),
    auction: auctionView,
    bidEvals: b.bidEvals,
  };

  // A "Play From Here" rehearsal: never scored (see the kind allowlist
  // exclusion on TournamentRow.kind), so the client needs to know it's
  // looking at one — Board.tsx uses this to relabel the header, add an END
  // action, and swap in the adjusted receipt instead of the ordinary
  // Result/ScoreReceipt once it finishes.
  if (t.kind === 'rehearsal' && t.origin_tournament_id != null && t.origin_board_no != null && t.branch_ply != null) {
    view.rehearsal = {
      originTournamentId: t.origin_tournament_id,
      originBoardNo: t.origin_board_no,
      branchPly: t.branch_ply,
    };
  }

  if (b.row.state === 'bidding') {
    if (!auction.isOver && auction.turn === HUMAN_SEAT) {
      const mask = legalCalls(auction);
      const legal = mask.map((ok, a) => (ok ? a : -1)).filter((a) => a >= 0);
      view.legalCalls = legal;
      // meanings shown to the user BEFORE they commit a bid
      view.legalCallMeanings = Object.fromEntries(legal.map((a) => [a, meaningFor(deal.dealer, b.calls, a)]));
      view.myTurn = true;
    }
  }

  if (b.row.state !== 'bidding' && b.contract) {
    const ps = playState(deal, b.contract, b.plays);
    // When partner (North) declares, the human takes over the declarer hand
    // and the board flips: North's cards at the bottom, South face up as dummy.
    const { playingSeat, dummySeat: dummy } = playingSeatFor(b.contract);
    const flipped = b.contract.declarer === partnerOf(HUMAN_SEAT);
    view.contract = b.contract;
    view.contractLabel = contractLabel(b.contract);
    view.declarer = b.contract.declarer;
    view.dummy = dummy;
    view.flipped = flipped;
    view.playingSeat = playingSeat;
    view.hand = remaining(deal, b.plays, playingSeat);
    view.hcp = hcp(deal.hands[playingSeat]);
    view.currentTrick = ps.currentTrick;
    view.completedTricks = ps.completedTricks.length;
    view.declarerTricks = ps.declarerTricks;
    view.defenderTricks = ps.defenderTricks;
    view.lastTrick = ps.completedTricks.length ? ps.completedTricks[ps.completedTricks.length - 1] : null;
    // The human always sees their own (South) cards; dummy is public after the
    // opening lead. Both conditions hold for every hand we ever send here.
    // Sent for 'done' too (not just 'playing'): a laydown claim can resolve
    // many tricks in one response, and the client's claim fast-forward
    // (stageClaimSteps) reconstructs dummy's hand shrinking trick-by-trick
    // from this same field — if it were omitted once the board flips to
    // 'done', dummy's whole fan would vanish instantly instead of animating.
    if ((b.row.state === 'playing' || b.row.state === 'done') && (ps.dummyVisible || dummy === HUMAN_SEAT)) {
      view.dummyHand = remaining(deal, b.plays, dummy);
      view.dummyHcp = hcp(deal.hands[dummy]);
    }
    if (b.row.state === 'playing' && !ps.isOver && humanControls(ps.handToPlay, b.contract)) {
      view.myTurn = true;
      view.handToPlay = ps.handToPlay;
      view.legalCards = legalCards(deal, ps);
    }
    // Pop-Up Quiz: a pending quiz presents this exactly like any other
    // "locked" snapshot already used elsewhere in this codebase (the
    // resync-on-reject path, staged robot-burst snapshots) — myTurn false,
    // no legalCards — so the client's forced-single-legal-card auto-play
    // effect is automatically inert whenever a quiz is pending, with no
    // separate client-side guard needed.
    if (b.row.state === 'playing') {
      const pending = pendingQuizView(b.row.id);
      if (pending) {
        view.quiz = pending;
        view.myTurn = false;
        delete view.legalCards;
      }
    }
  }

  if (b.row.state === 'done') {
    view.result = boardResult(t, b, viewerElo);
    view.allHands = deal.hands;
    view.playHistory = b.contract ? playState(deal, b.contract, b.plays).completedTricks : [];
    if (b.claimed) view.claimed = true;
    const report = quizReportCard(b.row.id);
    if (report) view.quizReportCard = report;
    // The origin board's own real result, for the adjusted-receipt
    // comparison — sent inline so the client never needs a second fetch. A
    // rehearsal's own `result.pct`/`.field` are meaningless (matchpoints()
    // returns a placeholder pct against a field of exactly one, since nobody
    // else ever plays a rehearsal tournament); the client compares scoreNS/
    // contractLabel against THIS field instead. originResult.pct is the real
    // "old" matchpoint pct the player actually earned at that table;
    // lineMatchpoints is the "new" counterfactual pct this line's score would
    // have earned against that same real field (see lineMatchpointsVsOrigin).
    if (t.kind === 'rehearsal' && t.origin_tournament_id != null && t.origin_board_no != null) {
      const originT = getTournament(t.origin_tournament_id);
      const originBoard = originT ? loadBoard(originT, b.row.user_id, t.origin_board_no, false) : null;
      if (originT && originBoard?.row.state === 'done') {
        // Fetched once and shared: boardResult needs it for originResult's
        // field/pct, lineMatchpointsVsOrigin needs it for the substitution —
        // same (tournament, board) query, no reason to run it twice.
        const originRows = stmtBoardResults.all(originT.id, originBoard.row.board_no) as (BoardRow & {
          user_handle: string;
          user_kind: 'human' | 'ai';
          user_google: string;
        })[];
        view.originResult = boardResult(originT, originBoard, viewerElo, originRows);
        view.lineMatchpoints = lineMatchpointsVsOrigin(originRows, b.row.user_id, b.row.score_ns);
      }
    }
  }
  return view;
}

function remaining(deal: Deal, plays: Card[], seat: Seat): Card[] {
  const played = new Set(plays);
  return deal.hands[seat].filter((c) => !played.has(c));
}

/**
 * Result + field comparison for a completed board. Same field as standings()
 * in tournaments.ts: everyone who finished the board — humans and benchmark
 * AI personas — matchpointed together in one pass. House rows are real pairs
 * in this comparison (see standings()'s doc comment); the persona/human
 * split survives only in Elo and placement.
 */
function boardResult(
  t: TournamentRow,
  b: GameBoard,
  _viewerElo: number,
  // Callers that already fetched this (tournament, board)'s field rows for
  // another purpose — boardView's rehearsal branch, for lineMatchpointsVsOrigin
  // — pass them straight through instead of paying for a second identical
  // query.
  rows: (BoardRow & { user_handle: string; user_kind: 'human' | 'ai'; user_google: string })[] = stmtBoardResults.all(
    t.id,
    b.row.board_no,
  ) as (BoardRow & { user_handle: string; user_kind: 'human' | 'ai'; user_google: string })[],
): Record<string, unknown> {
  const mps = matchpoints(rows.map((r) => r.score_ns ?? 0));
  const field = rows.map((r, i) => ({
    userId: r.user_id,
    handle: r.user_handle,
    kind: r.user_kind,
    tieRank: aiTieRank(r.user_google),
    contract: r.contract ? contractLabel(JSON.parse(r.contract), tricksOf(r)) : 'Passed out',
    scoreNS: r.score_ns ?? 0,
    pct: Math.round(mps[i].pct * 10) / 10,
    isMe: r.user_id === b.row.user_id,
  }));
  const mine = field.find((f) => f.isMe);
  return {
    contractLabel: b.contract ? contractLabel(b.contract, b.row.tricks_declarer ?? undefined) : 'Passed out',
    tricksDeclarer: b.row.tricks_declarer,
    scoreNS: b.row.score_ns,
    pct: mine?.pct ?? null,
    // score desc; ties break human-first then strongest persona first
    // (aiTieRank), same rule as standings() — tieRank is server-side only
    field: field
      .sort((a, b2) => b2.scoreNS - a.scoreNS || a.tieRank - b2.tieRank)
      .map(({ tieRank: _tieRank, ...f }) => f),
    bidAccuracy: bidAccuracy(b.bidEvals),
    // itemized duplicate scoring for the toll-receipt screen; null on a pass-out
    breakdown:
      b.contract && b.row.tricks_declarer != null
        ? scoreBreakdown(b.contract, b.deal.vul, b.row.tricks_declarer)
        : null,
  };
}

function tricksOf(r: BoardRow): number | undefined {
  return r.tricks_declarer ?? undefined;
}

/**
 * The finished-board rows a board is matchpointed against — the SAME query
 * boardResult() uses (everyone who finished the board, humans and house, in
 * updated_at order), exported for analyze.ts's counterfactual arithmetic so
 * the analysis can never disagree with the field table about who is in the
 * field. Analyze SUBSTITUTES its hypothetical score into this array by row
 * index — never appends — per tournaments.ts's order-preservation argument.
 */
export function boardFieldRows(tournamentId: number, boardNo: number): { user_id: number; score_ns: number | null }[] {
  return stmtBoardResults.all(tournamentId, boardNo) as (BoardRow & { user_handle: string })[];
}

/**
 * What matchpoint pct a "Play From Here" rehearsal LINE's score would have
 * earned against the origin board's own real field, substituting it for the
 * player's row — never appending, the same substitute-never-append rule
 * analyze.ts's counterfactual arithmetic uses. Takes the field rows rather
 * than re-querying them (boardFieldRows' own SELECT) so a caller that already
 * fetched them for another purpose — boardView's rehearsal branch, alongside
 * boardResult's originResult — pays for the query once. This does not make
 * the rehearsal itself scored (see rehearsal.ts's doc comment): the
 * rehearsal's own field is still exactly one player and its own matchpoints()
 * call would still be the meaningless placeholder — this reads the ORIGIN
 * tournament's already-real, already-scored field instead. Null when that
 * field has too few entrants for a pct to mean anything (matchpoints()
 * returns a placeholder 50 for n<=1, the same guard analyze.ts's singleField
 * uses).
 */
function lineMatchpointsVsOrigin(
  rows: { user_id: number; score_ns: number | null }[],
  userId: number,
  lineScoreNS: number | null,
): number | null {
  const myIndex = rows.findIndex((r) => r.user_id === userId);
  if (rows.length <= 1 || myIndex < 0) return null;
  const scores = rows.map((r) => r.score_ns ?? 0);
  scores[myIndex] = lineScoreNS ?? 0;
  return Math.round(matchpoints(scores)[myIndex].pct * 10) / 10;
}

function bidAccuracy(evals: { score: number }[]): number | null {
  if (!evals.length) return null;
  return Math.round((evals.reduce((s, e) => s + e.score, 0) / evals.length) * 100);
}

export function httpError(status: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = status;
  return err;
}
