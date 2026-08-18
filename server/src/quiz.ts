import { Call, Card, Contract, Deal, Seat } from '@bridge/core';
import { DifficultyTier, QuestionType, quizSeed, quizSeedForTrick, selectQuizQuestion, triggerTricks } from '@bridge/ai';
import { db } from './db.js';

/**
 * Pop-Up Quiz — DB access and generation orchestration. Mirrors analyze.ts's
 * relationship to packages/ai: this file owns the `pop_quizzes` row and the
 * frequency preference; server/src/game.ts owns advancing the board and
 * deciding WHEN to call in here (see advanceRobots' trigger-check, which is a
 * new stopping condition alongside "it's the human's turn" and "the board is
 * done" — see CLAUDE.md's "Pop-Up Quiz" section for the full design record).
 *
 * Deliberately independent of game.ts's `GameBoard`/`TournamentRow` types (no
 * import from game.ts at all, in either direction) — `QuizGenerationContext`
 * below carries exactly the fields generation needs as plain data, so there's
 * no circular-module question to reason about.
 */

function quizError(status: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = status;
  return err;
}

const stmtUserFreq = db.prepare(`SELECT quiz_frequency FROM users WHERE id = ?`);

export function quizFrequency(userId: number): 'never' | 'sometimes' | 'often' {
  return (stmtUserFreq.get(userId) as { quiz_frequency: 'never' | 'sometimes' | 'often' } | undefined)?.quiz_frequency ?? 'never';
}

const stmtHasPending = db.prepare(`SELECT 1 FROM pop_quizzes WHERE board_id = ? AND answer IS NULL LIMIT 1`);

/** The authoritative cross-call gate — checked FIRST, before anything else,
 *  on every call to advanceRobots's 'playing' branch. A single indexed read;
 *  this is what makes "a pending quiz freezes the board" true across every
 *  call (reload, a second tab, ensureAdvanced, submitQuizAnswer's own
 *  resumed call), not just within the request that generated it. */
export function hasPendingQuiz(boardId: number): boolean {
  return stmtHasPending.get(boardId) !== undefined;
}

export interface QuizGenerationContext {
  boardId: number;
  userId: number;
  /** TournamentRow['kind'] — spelled out here rather than imported, so this
   *  file carries no dependency on game.ts/db.ts's tournament types */
  tournamentKind: 'standard' | 'exhibit' | 'rehearsal';
  tournamentSeed: string;
  boardNo: number;
  /** the board's persisted claim boundary, if any — defense-in-depth against
   *  generating a quiz inside a claim's server-decided tail (game.ts's
   *  `quizCheckedThroughTrick = 13` fix is the primary guarantee; this is the
   *  second, independent one) */
  claimedAtPly: number | null;
  deal: Deal;
  contract: Contract;
  dealer: Seat;
  calls: Call[];
  /** the board's FULL plays so far — sliced internally to the trigger
   *  trick's boundary (trick*4), never read past it */
  plays: Card[];
}

const stmtInsertQuiz = db.prepare(
  `INSERT OR IGNORE INTO pop_quizzes
     (board_id, trick, ply, question_type, difficulty_tier, multi_select, prompt, options, correct_answer, reasoning)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

/**
 * Called from advanceRobots's loop at a newly-crossed trick boundary, only
 * once `hasPendingQuiz` has already confirmed there's nothing outstanding.
 * `playingSeat`/`dummySeat` must be threaded in from the caller's own
 * `playingSeatFor(contract)` — this function never re-derives the hand-flip
 * itself (see packages/ai/src/quiz.ts's `deriveQuizKnowledge` doc comment for
 * why that duplication is exactly the bug class to avoid).
 *
 * Returns true iff it generated and persisted a quiz (the caller must stop
 * advancing this response). No DD/solve work happens here at all — quiz
 * generation only needs the sampled hidden-hand LAYOUTS (packages/ai's
 * `sampleLayouts`), never a double-dummy verdict about how they'd be played,
 * so this is synchronous and cheap; unlike scoreCardsSampled, there is no
 * `priority` to forward to a solve.
 *
 * The INSERT is the only statement that mutates anything, and it's last: if
 * generation throws partway through, no partial row is ever written.
 */
export function maybeGenerateQuiz(ctx: QuizGenerationContext, trick: number, playingSeat: Seat, dummySeat: Seat): boolean {
  if (ctx.tournamentKind !== 'standard') return false;
  if (trick * 4 > (ctx.claimedAtPly ?? Infinity)) return false;
  const user = stmtUserFreq.get(ctx.userId) as { quiz_frequency: 'never' | 'sometimes' | 'often' } | undefined;
  const freq = user?.quiz_frequency;
  if (freq !== 'sometimes' && freq !== 'often') return false;
  const seed = quizSeed(ctx.tournamentSeed, ctx.boardNo, freq);
  if (!triggerTricks(seed, freq).includes(trick)) return false;

  const q = selectQuizQuestion(
    ctx.deal,
    ctx.contract,
    ctx.plays.slice(0, trick * 4),
    ctx.dealer,
    ctx.calls,
    playingSeat,
    dummySeat,
    trick,
    quizSeedForTrick(ctx.tournamentSeed, ctx.boardNo, freq, trick),
  );
  if (!q) return false;

  const result = stmtInsertQuiz.run(
    ctx.boardId,
    trick,
    trick * 4,
    q.type,
    q.tier,
    q.multiSelect ? 1 : 0,
    q.prompt,
    JSON.stringify(q.options),
    JSON.stringify(q.correctAnswer),
    q.reasoning,
  );
  return result.changes > 0;
}

interface PendingQuizRow {
  id: number;
  trick: number;
  question_type: QuestionType;
  difficulty_tier: DifficultyTier;
  multi_select: number;
  prompt: string;
  options: string;
}

const stmtPending = db.prepare(
  `SELECT id, trick, question_type, difficulty_tier, multi_select, prompt, options
   FROM pop_quizzes WHERE board_id = ? AND answer IS NULL LIMIT 1`,
);

export interface PendingQuizView {
  id: number;
  trick: number;
  questionType: QuestionType;
  difficultyTier: DifficultyTier;
  multiSelect: boolean;
  prompt: string;
  options: string[];
}

/** boardView's redacted live view — never includes correctAnswer/reasoning. */
export function pendingQuizView(boardId: number): PendingQuizView | null {
  const row = stmtPending.get(boardId) as PendingQuizRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    trick: row.trick,
    questionType: row.question_type,
    difficultyTier: row.difficulty_tier,
    multiSelect: row.multi_select !== 0,
    prompt: row.prompt,
    options: JSON.parse(row.options),
  };
}

function sameAnswer(a: number[], b: number[]): boolean {
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

interface FullQuizRow {
  id: number;
  correct_answer: string;
  answer: string | null;
}

const stmtQuizById = db.prepare(`SELECT id, correct_answer, answer FROM pop_quizzes WHERE id = ? AND board_id = ?`);
const stmtRecordAnswer = db.prepare(`UPDATE pop_quizzes SET answer = ?, correct = ?, answered_at = unixepoch() WHERE id = ?`);

/**
 * Pure DB validate-and-record step: checks quizId belongs to boardId and
 * isn't already answered, scores the answer against the frozen
 * correct_answer, writes answer/correct/answered_at. Does NOT advance play or
 * touch the boards table — that's game.ts's `submitQuizAnswer`'s job.
 */
export function recordQuizAnswer(boardId: number, quizId: number, answer: number[]): void {
  const row = stmtQuizById.get(quizId, boardId) as FullQuizRow | undefined;
  if (!row) throw quizError(404, 'quiz not found');
  if (row.answer !== null) throw quizError(409, 'quiz already answered');
  const correct = sameAnswer(answer, JSON.parse(row.correct_answer) as number[]);
  stmtRecordAnswer.run(JSON.stringify([...answer].sort((a, b) => a - b)), correct ? 1 : 0, quizId);
}

const stmtReportCard = db.prepare(`SELECT trick, question_type, prompt, correct FROM pop_quizzes WHERE board_id = ? ORDER BY trick`);

export interface QuizReportRow {
  trick: number;
  questionType: QuestionType;
  description: string;
  correct: boolean;
}

/** Result screen — summary only, no reasoning, only meaningful once the board
 *  is done (a board can never finish with an unanswered quiz — see the
 *  cross-call gate above — so every row here is already answered). */
export function quizReportCard(boardId: number): QuizReportRow[] | null {
  const rows = stmtReportCard.all(boardId) as { trick: number; question_type: QuestionType; prompt: string; correct: number | null }[];
  if (!rows.length) return null;
  return rows.map((r) => ({ trick: r.trick, questionType: r.question_type, description: r.prompt, correct: r.correct === 1 }));
}

const stmtAnalyzeReveal = db.prepare(
  `SELECT ply, question_type, difficulty_tier, multi_select, prompt, options, correct_answer, answer, correct, reasoning
   FROM pop_quizzes WHERE board_id = ? ORDER BY trick`,
);

export interface QuizAnalyzeRow {
  ply: number;
  questionType: QuestionType;
  difficultyTier: DifficultyTier;
  multiSelect: boolean;
  prompt: string;
  options: string[];
  yourAnswer: number[];
  correctAnswer: number[];
  correct: boolean;
  /** full reasoning, but only on a miss — a correct answer needs no explaining */
  reasoning: string | null;
}

/** Analyze's deeper reveal — full reasoning, but only on misses. */
export function quizAnalyzeReveal(boardId: number): QuizAnalyzeRow[] | null {
  const rows = stmtAnalyzeReveal.all(boardId) as {
    ply: number;
    question_type: QuestionType;
    difficulty_tier: DifficultyTier;
    multi_select: number;
    prompt: string;
    options: string;
    correct_answer: string;
    answer: string | null;
    correct: number | null;
    reasoning: string;
  }[];
  if (!rows.length) return null;
  return rows.map((r) => {
    const correct = r.correct === 1;
    return {
      ply: r.ply,
      questionType: r.question_type,
      difficultyTier: r.difficulty_tier,
      multiSelect: r.multi_select !== 0,
      prompt: r.prompt,
      options: JSON.parse(r.options),
      yourAnswer: r.answer ? JSON.parse(r.answer) : [],
      correctAnswer: JSON.parse(r.correct_answer),
      correct,
      reasoning: correct ? null : r.reasoning,
    };
  });
}

export interface CardCountingStats {
  totalAnswered: number;
  totalCorrect: number;
  /** rounded percentage, null when totalAnswered === 0 */
  accuracyPct: number | null;
  byType: { type: QuestionType; total: number; correct: number }[];
  /** always all three tiers, in easy/medium/hard order, even at 0/0 */
  byTier: { tier: DifficultyTier; total: number; correct: number }[];
  /** chronological (oldest first), for a simple accuracy trend sparkline */
  trend: { at: number; correct: boolean }[];
}

const stmtUserQuizzes = db.prepare(
  `SELECT pq.question_type, pq.difficulty_tier, pq.correct, pq.answered_at
   FROM pop_quizzes pq
   JOIN boards b ON b.id = pq.board_id
   JOIN tournaments t ON t.id = b.tournament_id AND t.kind = 'standard'
   WHERE b.user_id = ? AND pq.answer IS NOT NULL
   ORDER BY pq.answered_at, pq.id`,
);

const TIERS: DifficultyTier[] = ['easy', 'medium', 'hard'];

/** stats.ts's Card Counting panel — aggregated across all of a user's
 *  answered quizzes. `null` ONLY when the player's CURRENT setting is
 *  'never' — a real (possibly all-zero, if opted in but not yet answered
 *  anything) object otherwise. compare.ts's gating leans on that contract
 *  directly rather than a second live column read. */
export function quizStatsForUser(userId: number): CardCountingStats | null {
  if (quizFrequency(userId) === 'never') return null;
  const rows = stmtUserQuizzes.all(userId) as { question_type: QuestionType; difficulty_tier: DifficultyTier; correct: number; answered_at: number }[];

  const byType = new Map<QuestionType, { total: number; correct: number }>();
  const byTier = new Map<DifficultyTier, { total: number; correct: number }>(TIERS.map((t) => [t, { total: 0, correct: 0 }]));
  let totalCorrect = 0;
  const trend: { at: number; correct: boolean }[] = [];
  for (const r of rows) {
    const type = byType.get(r.question_type) ?? { total: 0, correct: 0 };
    type.total++;
    if (r.correct === 1) type.correct++;
    byType.set(r.question_type, type);

    const tier = byTier.get(r.difficulty_tier)!;
    tier.total++;
    if (r.correct === 1) tier.correct++;

    if (r.correct === 1) totalCorrect++;
    trend.push({ at: r.answered_at, correct: r.correct === 1 });
  }

  return {
    totalAnswered: rows.length,
    totalCorrect,
    accuracyPct: rows.length ? Math.round((totalCorrect / rows.length) * 100) : null,
    byType: [...byType.entries()].map(([type, c]) => ({ type, ...c })).sort((a, b) => b.total - a.total),
    byTier: TIERS.map((tier) => ({ tier, ...byTier.get(tier)! })),
    trend,
  };
}
