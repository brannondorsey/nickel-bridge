/**
 * Compare — two players' records side by side, with an honest threshold.
 *
 * The screen draws each measure as a "beam": a track with a centre line, a bar
 * growing left (the viewer leads) or right (the other player leads) by the
 * MARGIN, and two dashed "gates" at the margin below which the difference is
 * inside its own measurement error. Three outcomes per row:
 *
 *   called    — the margin clears its gate; the bar takes a side and a colour
 *   level     — a real lean, but short of the gate; grey, no winner named
 *   set aside — the gate is wider than the whole scale, so the row could never
 *               be called whatever the figures say; not drawn, only counted
 *
 * WHY A GATE AT ALL. Without one, "63% against 71%" reads as a lead when it is
 * eight points across 58 boards and 74 — noise wearing a colour. The page's
 * whole claim is that it does not flatter, and a bare comparison of two rates
 * flatters whoever happens to have played fewer boards.
 *
 * WHY DIRECTION CARRIES THE VERDICT AND COLOUR ONLY REINFORCES IT. In
 * web/src/style.css, --positive is byte-identical to --suit-c (clubs) and
 * --negative to --suit-h (hearts); worse, the colourblind suit palette rewrites
 * the suit tokens and leaves these two alone, so a player who turned that
 * setting on *because* red and green are hard for them would meet the one
 * screen in the app that is entirely red and green. Side-of-centre and
 * gate-crossing are therefore the real encoding — flatten every fill to one ink
 * and the page still reports every verdict correctly.
 *
 * This module is a PURE FUNCTION of two PlayerStats objects (plus the two
 * relationship extras the profile endpoint has no reason to compute). That
 * works because everything the gates need is already collected:
 *   - bid-accuracy spread comes from `totals.gradeCounts`, since
 *     `gradeFromProbs` (packages/ai/src/bidder.ts) maps grade to score
 *     bijectively — excellent 1, good 0.75, fair 0.4, poor 0 — and the advisor
 *     floor moves both together;
 *   - matchpoint spread comes from `pctSeries[].pct`;
 *   - every other measure exposes its own numerator and denominator.
 * So no new stats collection was needed for any of this.
 */

import { QuestionType } from '@bridge/ai';
import { BidCategory, ConventionFamily } from '@bridge/core';
import {
  commonGround,
  completedBoardCount,
  memoizedStandings,
  pairRecord,
  playerIdentity,
  playerStats,
  type CommonGroundRow,
  type PairRecord,
  type PlayerStats,
} from './stats.js';

/**
 * How many standard errors a margin must clear to be called.
 *
 * ONE, deliberately, and the trade-off is real enough to write down. Under the
 * null hypothesis that two players are identical, |margin| exceeds 1σ about 32%
 * of the time — so across the ~19 measures this screen draws, roughly six rows
 * will be coloured by chance alone on two genuinely equal players. 1.5σ cuts
 * that to about 2.5.
 *
 * It is 1.0 because of what the live data actually looks like (measured
 * 2026-07-31, see FULL_TILT): at 1.5σ virtually every row was set aside even
 * for the five players with real records, and a screen that never says anything
 * is not more honest, only less useful. The mitigation is COMPARE_MIN_BOARDS
 * below — the screen is only offered to players with a few hundred graded calls
 * behind them, where the gates are tight enough that a called row usually means
 * something.
 *
 * If the page starts feeling like it flatters, this is the one number to move.
 */
export const GATE_SIGMA = 1.0;

/**
 * Both players need this many completed boards before Compare is offered.
 *
 * 16 matches the outreach skill's `RETAINED_BOARDS` and is roughly the four
 * rated tournaments the leaderboard itself gates on. Below it a comparison is
 * all set-aside rows: at the median record when this was written (4 boards, 9
 * graded calls, 2 declared boards) there is simply nothing a threshold can
 * responsibly say. The entry points hide themselves below this, and a direct
 * navigation gets an explicit "not enough crossings yet" screen rather than an
 * error or an empty page.
 */
export const COMPARE_MIN_BOARDS = 16;

/**
 * The demo relaxation, for exactly the reason `DEMO_PROVISIONAL_MIN_TOURNAMENTS`
 * exists: the demo seeder's bots top out at EIGHT completed boards, so at the
 * production floor every comparison on a preview would show the "not enough
 * crossings yet" screen and the feature would be unreachable in the one
 * environment built to click-test it. That is not hypothetical — it is the same
 * bug that once made the activity feed's `entered-rankings` milestone
 * untestable, which is why the floor is passed to `buildCompare` as an argument
 * and read from the environment in exactly one place (app.ts's `compareMin`).
 */
export const DEMO_COMPARE_MIN_BOARDS = 4;

/**
 * The floor in force, and the ONE place `DEMO` is consulted for it — the same
 * discipline app.ts's `provisionalMin()` applies to the rating quota, for the
 * same reason. It lives here rather than in app.ts only because auth.ts also
 * needs it (to tell the client via /api/me), and importing it from app.ts would
 * close a cycle: app -> auth -> app.
 *
 * Everything downstream takes the number as an ARGUMENT. Nothing else in this
 * module reads an environment variable.
 */
export const compareMin = () =>
  process.env.DEMO === '1' ? DEMO_COMPARE_MIN_BOARDS : COMPARE_MIN_BOARDS;

/**
 * The margin at which a bar reaches the end of its track — i.e. what "a class
 * apart" looks like for each measure. It does two jobs: it scales every bar,
 * and (via the set-aside rule) it decides which rows are capable of being
 * called at all.
 *
 * MEASURED 2026-07-31 against production, as the p10–p90 spread among the
 * players with >= 16 completed boards (n=5, median 78 boards / 218 graded calls
 * / 20 tournaments). The whole-population spread was deliberately NOT used: at
 * a median of 4 boards, per-player rates are 0/50/100 and the "spread" is
 * sampling noise, not skill — defending ran the full 0%–100%.
 *
 * n=5 IS A THIN CALIBRATION SAMPLE. Re-measure as the population grows; a
 * read-only quantile query over `boards`/`bid_evals` is all it takes. If
 * ratings ever spread wider than 1077–1368, `elo` here is the first to move.
 *
 * The three bucketed panels (bid type, convention, contract tier) are widened
 * past the pooled figure on purpose: a per-bucket rate varies more than the
 * average of all buckets, so calibrating them to the pooled spread would set
 * aside rows that had something to say.
 */
const FULL_TILT = {
  elo: 140, //          1077 → 1368
  avgPct: 15, //        30.2 → 60.9
  bidAccuracy: 7, //    70.9 → 84.5
  declaring: 14, //     40.0 → 68.6
  defending: 10, //     25.0 → 45.5
  tops: 5, //            5.6 → 16.0
  bidType: 15, //       widened from the pooled ★★+ share
  convention: 20, //    smaller samples again
  contract: 20,
  /**
   * Pop-Up Quiz's Card Counting row. Unlike every other value above, this is
   * NOT measured against production — there is no quiz data yet to calibrate
   * against (the feature is shipping alongside this constant). Ships as a
   * documented launch estimate, the same way MOMENT_FLOOR and the difficulty
   * split in packages/ai/src/quiz.ts shipped as judgment calls pending real
   * telemetry — re-measure this the same way FULL_TILT's other rows were
   * (p10-p90 spread among players clearing COMPARE_MIN_BOARDS with Pop
   * Quizzes on) once there's a real population to measure.
   *
   * A badly-chosen value can't flip a verdict (classify()'s call/no-call
   * split is driven by the Agresti-Coull gate vs. the margin, independent of
   * fullTilt) — only over-suppress rows as "thin" or under-scale the bar. With
   * nothing to calibrate against, err WIDE: a value that sets aside more
   * borderline comparisons as inconclusive is the safer failure direction for
   * a screen whose whole credibility rests on "this doesn't flatter." 15
   * matches avgPct's spread (also a percentage-point rate over a comparable
   * sample size) rather than the tighter bidAccuracy figure.
   */
  quizAccuracy: 15,
} as const;

/**
 * Elo gets a flat band rather than a computed standard error: a rating is not a
 * rate over n trials, and the replay model (wiped and recomputed in
 * tournament-id order on every scored board) gives it no per-player variance to
 * read off. 25 points is roughly one K-factor swing (K = 24, packages/core), so
 * a margin inside it is within a single tournament's movement.
 */
const ELO_SE = 25;

/** The four-point scale `gradeFromProbs` emits, and the only scores that exist. */
const GRADE_SCORE = { excellent: 1, good: 0.75, fair: 0.4, poor: 0 } as const;

export type Verdict = 'you' | 'them' | 'level' | 'aside';

/** Why a row was set aside, so the screen can say it rather than just omit.
 *  'disabled' is unique to the quiz-accuracy row: at least one side's CURRENT
 *  Pop Quizzes setting is 'never', so there's nothing comparable — distinct
 *  from 'no-data' (both have quizzing on, but the sample is too thin/absent
 *  to say anything, which still goes through 'no-data'/'thin' as usual). */
export type AsideReason = 'thin' | 'provisional' | 'no-data' | 'disabled';

export type MeasurePanel = 'headline' | 'bidType' | 'convention' | 'contract';

export interface Measure {
  /** stable id: 'elo', 'bidType:opening', 'convention:stayman', … */
  key: string;
  label: string;
  panel: MeasurePanel;
  /** display values — the RAW figures, never the error-adjusted ones */
  a: number | null;
  b: number | null;
  unit: 'elo' | 'pct' | 'pct1';
  /** a − b in display units; 0 when either side is null */
  margin: number;
  /**
   * GATE_SIGMA × combined standard error, in display units.
   *
   * NULL when the error is unbounded — a rate over zero boards, or a sample too
   * small to estimate spread. Explicitly null rather than Infinity because
   * `JSON.stringify(Infinity)` is `null` anyway, so typing it `number` was a
   * wire-type lie: the `contract:slam` row hits this in most real comparisons.
   * Such a row is always `aside`, so nothing draws or prints the gate.
   */
  gate: number | null;
  fullTilt: number;
  verdict: Verdict;
  reason?: AsideReason;
  /** sample size behind each figure, for the row's sub-line */
  samples: [number, number];
  /** quiz-accuracy row only: the "▾ BY QUESTION TYPE" disclosure — each
   *  question type both players have answered at least once, rounded pcts */
  breakdown?: { key: string; label: string; a: number; b: number }[];
}

export interface ContextRow {
  key: string;
  label: string;
  a: number | null;
  b: number | null;
  unit: 'elo' | 'pct' | 'pct1' | 'count' | 'delta';
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Standard error of a rate, with the Agresti–Coull adjustment.
 *
 * THIS IS NOT A REFINEMENT, IT IS REQUIRED. The textbook `√(p(1−p)/n)` is
 * exactly ZERO at p = 0 and p = 1, so a player who has made two contracts out
 * of two would get a gate of zero and *any* difference against them would be
 * called with total confidence. That is not a corner case here: when this was
 * written, 11 of the 24 players with any declared board sat at exactly 0% or
 * 100%. The failure mode is precisely the one this whole module exists to
 * prevent, and it would have hit half the player base.
 *
 * So the error is computed on the shrunk estimate p̃ = (x + 2)/(n + 4) over
 * ñ = n + 4 — which pulls a 2-of-2 record toward the middle and gives it an
 * honestly wide error — while the figure the screen PRINTS stays the raw rate.
 * The player still sees "100%"; the page just declines to build a verdict on it.
 */
function rateSe(made: number, n: number): number {
  if (n <= 0) return Infinity;
  const nTilde = n + 4;
  const pTilde = (made + 2) / nTilde;
  return Math.sqrt((pTilde * (1 - pTilde)) / nTilde);
}

/**
 * Population standard error of a mean: σ/√n.
 *
 * A variance of exactly zero is not evidence of certainty — it means the sample
 * is too small or too uniform to estimate spread at all — so it returns
 * Infinity, which sets the row aside rather than handing it a gate of zero.
 * Same failure this module guards against in `rateSe`, one measure over.
 */
function meanSe(values: number[]): number {
  const n = values.length;
  if (n < 2) return Infinity;
  const mu = sum(values) / n;
  const variance = sum(values.map((v) => (v - mu) ** 2)) / n;
  if (variance === 0) return Infinity;
  return Math.sqrt(variance / n);
}

/**
 * Bid accuracy's standard error, from the grade histogram.
 *
 * Bid accuracy is the mean of a FOUR-POINT DISCRETE score, not a proportion —
 * so `√(p(1−p)/n)` is the wrong distribution and overstates its spread by about
 * a third. The trap is that the measure one panel below (`bidTypes[]`'s
 * satisfactory-or-better share) genuinely IS a proportion, so the binomial
 * formula is correct there and wrong here. Returns percentage points.
 */
function accuracySe(counts: PlayerStats['totals']['gradeCounts']): number {
  const entries = Object.entries(GRADE_SCORE) as [keyof typeof GRADE_SCORE, number][];
  const raw = sum(entries.map(([g]) => counts[g]));
  if (raw < 2) return Infinity;
  // Two pseudo-observations at the ends of the score range — the bounded-mean
  // analogue of the Agresti-Coull shrinkage in `rateSe`, and needed for the
  // same reason: a player whose graded calls are ALL 'excellent' has a sample
  // variance of exactly zero, which would hand the row a gate of zero and let
  // any difference be called. Plausible at the median record of nine calls,
  // and it washes out to nothing by a few hundred.
  const observations: [number, number][] = [...entries.map(([g, s]) => [counts[g], s] as [number, number]), [1, 0], [1, 1]];
  const n = raw + 2;
  const mu = sum(observations.map(([c, s]) => c * s)) / n;
  const variance = sum(observations.map(([c, s]) => c * (s - mu) ** 2)) / n;
  return Math.sqrt(variance / n) * 100;
}

/** Two independent errors combine in quadrature. */
const combine = (seA: number, seB: number) => Math.sqrt(seA ** 2 + seB ** 2);

/**
 * Which side a margin falls on, given its gate and its scale.
 *
 * Order matters: a gate wider than full tilt means the row can never be called
 * however large the margin, so it is set aside BEFORE the margin is consulted —
 * otherwise a wild difference on four boards would be reported as a verdict.
 */
function classify(margin: number, gate: number, fullTilt: number): { verdict: Verdict; reason?: AsideReason } {
  if (!Number.isFinite(gate)) return { verdict: 'aside', reason: 'no-data' };
  if (gate > fullTilt) return { verdict: 'aside', reason: 'thin' };
  if (Math.abs(margin) >= gate) return { verdict: margin > 0 ? 'you' : 'them' };
  return { verdict: 'level' };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * A gate for the wire: rounded, or null when the error is unbounded.
 * `JSON.stringify(Infinity)` is `null` regardless, so emitting it
 * deliberately keeps the declared type honest — see Measure.gate.
 */
const wireGate = (n: number) => (Number.isFinite(n) ? round1(n) : null);

/** Build one rate-based row (declaring, defending, tops, and every bucket panel). */
function rateMeasure(
  key: string,
  label: string,
  panel: MeasurePanel,
  fullTilt: number,
  a: { made: number; n: number },
  b: { made: number; n: number },
): Measure {
  const pctA = a.n ? (a.made / a.n) * 100 : null;
  const pctB = b.n ? (b.made / b.n) * 100 : null;
  const gate = combine(rateSe(a.made, a.n), rateSe(b.made, b.n)) * 100 * GATE_SIGMA;
  const dispA = pctA === null ? null : Math.round(pctA);
  const dispB = pctB === null ? null : Math.round(pctB);
  // The margin is the difference of the DISPLAYED (rounded) figures, not the
  // raw rates — matching bidAccuracy/avgPct/elo below, whose margins are also
  // differences of already-rounded values. Subtracting the raw rates instead
  // let a row print e.g. "71% vs 66%" (a 5-point gap by eye) while reporting
  // a margin of 4.3, which reads as the page disagreeing with itself.
  const margin = dispA !== null && dispB !== null ? dispA - dispB : 0;
  const { verdict, reason } =
    dispA === null || dispB === null ? { verdict: 'aside' as Verdict, reason: 'no-data' as AsideReason } : classify(margin, gate, fullTilt);
  return {
    key,
    label,
    panel,
    a: dispA,
    b: dispB,
    unit: 'pct',
    margin: round1(margin),
    gate: wireGate(gate),
    fullTilt,
    verdict,
    ...(reason ? { reason } : {}),
    samples: [a.n, b.n],
  };
}

/** Display names for the auction-role buckets — mirrors web's BID_TYPE_LABELS. */
const BID_TYPE_LABELS: Record<BidCategory, string> = {
  opening: 'OPENINGS',
  response: 'RESPONSES',
  rebid: 'REBIDS',
  overcall: 'OVERCALLS',
  double: 'DOUBLES',
  pass: 'PASSES',
};

/** Display names for Pop-Up Quiz's question types — mirrors web's
 *  QUESTION_TYPE_LABELS in Player.tsx/Compare.tsx. */
const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  'suit-count': 'SUIT LENGTH',
  'opponent-length': 'OPPONENT LENGTH',
  void: 'VOIDS',
  'trump-count': 'TRUMP COUNT',
  'honor-location': 'HONOR LOCATION',
  'suit-exhaustion': 'SUIT EXHAUSTION',
  'running-total': 'RUNNING TOTAL',
};

const CONVENTION_LABELS: Record<ConventionFamily, string> = {
  stayman: 'STAYMAN',
  jacobyTransfer: 'JACOBY TRANSFERS',
  blackwood: 'BLACKWOOD',
  gerber: 'GERBER',
  weakTwo: 'WEAK TWOS',
  negativeDouble: 'NEGATIVE DOUBLES',
  michaels: 'MICHAELS',
};

/**
 * Every judged measure, in the order the screen draws them: the headline six
 * first (the summary verdict), then bidding by type — the largest samples in
 * the app and the most actionable thing here — then conventions, then contract
 * tiers, where the samples thin out and most rows are set aside.
 */
export function buildMeasures(a: PlayerStats, b: PlayerStats, provisionalMin: number): Measure[] {
  const out: Measure[] = [];
  const ta = a.totals;
  const tb = b.totals;

  // ---- headline ----

  // Elo, unless either side is still provisional or is a house persona (which
  // never rate at all — their eloSeries is empty by construction).
  const ratedA = a.eloSeries.length;
  const ratedB = b.eloSeries.length;
  const eloGate = ELO_SE * Math.SQRT2 * GATE_SIGMA;
  const eloProvisional = ratedA < provisionalMin || ratedB < provisionalMin;
  const eloMargin = ta.currentElo - tb.currentElo;
  out.push({
    key: 'elo',
    label: 'NICKEL RATING',
    panel: 'headline',
    a: ta.currentElo,
    b: tb.currentElo,
    unit: 'elo',
    margin: eloMargin,
    gate: wireGate(eloGate),
    fullTilt: FULL_TILT.elo,
    ...(eloProvisional
      ? { verdict: 'aside' as Verdict, reason: 'provisional' as AsideReason }
      : classify(eloMargin, eloGate, FULL_TILT.elo)),
    samples: [ratedA, ratedB],
  });

  // Matchpoints — the spread comes from the per-crossing series, not a rate.
  const pctsA = a.pctSeries.map((p) => p.pct);
  const pctsB = b.pctSeries.map((p) => p.pct);
  const mpGate = combine(meanSe(pctsA), meanSe(pctsB)) * GATE_SIGMA;
  const mpMargin = ta.avgPct !== null && tb.avgPct !== null ? ta.avgPct - tb.avgPct : 0;
  out.push({
    key: 'avgPct',
    label: 'MATCHPOINTS',
    panel: 'headline',
    a: ta.avgPct,
    b: tb.avgPct,
    unit: 'pct1',
    margin: round1(mpMargin),
    gate: wireGate(mpGate),
    fullTilt: FULL_TILT.avgPct,
    ...(ta.avgPct === null || tb.avgPct === null
      ? { verdict: 'aside' as Verdict, reason: 'no-data' as AsideReason }
      : classify(mpMargin, mpGate, FULL_TILT.avgPct)),
    samples: [pctsA.length, pctsB.length],
  });

  // Bid accuracy — four-point score, so σ/√n, not binomial. See accuracySe.
  const callsA = sum(Object.values(ta.gradeCounts));
  const callsB = sum(Object.values(tb.gradeCounts));
  const accGate = combine(accuracySe(ta.gradeCounts), accuracySe(tb.gradeCounts)) * GATE_SIGMA;
  const accMargin =
    ta.avgBidAccuracy !== null && tb.avgBidAccuracy !== null ? ta.avgBidAccuracy - tb.avgBidAccuracy : 0;
  out.push({
    key: 'bidAccuracy',
    label: 'BID ACCURACY',
    panel: 'headline',
    a: ta.avgBidAccuracy,
    b: tb.avgBidAccuracy,
    unit: 'pct',
    margin: round1(accMargin),
    gate: wireGate(accGate),
    fullTilt: FULL_TILT.bidAccuracy,
    ...(ta.avgBidAccuracy === null || tb.avgBidAccuracy === null
      ? { verdict: 'aside' as Verdict, reason: 'no-data' as AsideReason }
      : classify(accMargin, accGate, FULL_TILT.bidAccuracy)),
    samples: [callsA, callsB],
  });

  out.push(
    rateMeasure('declaring', 'DECLARING', 'headline', FULL_TILT.declaring,
      { made: ta.declarer.made, n: ta.declarer.boards },
      { made: tb.declarer.made, n: tb.declarer.boards }),
  );
  out.push(
    rateMeasure('defending', 'DEFENDING', 'headline', FULL_TILT.defending,
      { made: ta.defense.beat, n: ta.defense.boards },
      { made: tb.defense.beat, n: tb.defense.boards }),
  );
  // Tops as a RATE per board, never a raw count — a count only rewards playing
  // more, and the margin would then share no unit with the figures shown.
  out.push(
    rateMeasure('tops', 'TOPS PER BOARD', 'headline', FULL_TILT.tops,
      { made: ta.tops.count, n: ta.boardsCompleted },
      { made: tb.tops.count, n: tb.boardsCompleted }),
  );

  // ---- Card Counting (Pop-Up Quiz accuracy) — gated on BOTH players
  // currently having Pop Quizzes on. `quizStats` is null exactly when a
  // player's current setting is 'never' (see quiz.ts's quizStatsForUser
  // contract), so that null-ness alone is the gate — no second live column
  // read, keeping this module a pure function of two PlayerStats objects.
  if (a.quizStats && b.quizStats) {
    const quizMeasure = rateMeasure('quizAccuracy', 'CARD COUNTING', 'headline', FULL_TILT.quizAccuracy,
      { made: a.quizStats.totalCorrect, n: a.quizStats.totalAnswered },
      { made: b.quizStats.totalCorrect, n: b.quizStats.totalAnswered });
    const bByType = new Map(b.quizStats.byType.map((x) => [x.type, x]));
    const breakdown = a.quizStats.byType
      .filter((x) => bByType.has(x.type))
      .map((x) => {
        const y = bByType.get(x.type)!;
        return {
          key: x.type,
          label: QUESTION_TYPE_LABELS[x.type],
          a: Math.round((x.correct / x.total) * 100),
          b: Math.round((y.correct / y.total) * 100),
        };
      });
    out.push(breakdown.length ? { ...quizMeasure, breakdown } : quizMeasure);
  } else {
    out.push({
      key: 'quizAccuracy',
      label: 'CARD COUNTING',
      panel: 'headline',
      a: a.quizStats?.accuracyPct ?? null,
      b: b.quizStats?.accuracyPct ?? null,
      unit: 'pct',
      margin: 0,
      gate: null,
      fullTilt: FULL_TILT.quizAccuracy,
      verdict: 'aside',
      reason: 'disabled',
      samples: [a.quizStats?.totalAnswered ?? 0, b.quizStats?.totalAnswered ?? 0],
    });
  }

  // ---- bidding by type: the intersection, in the server's ranked order ----
  const bidB = new Map(b.bidTypes.map((x) => [x.category, x]));
  for (const x of a.bidTypes) {
    const y = bidB.get(x.category);
    if (!y) continue;
    out.push(
      rateMeasure(`bidType:${x.category}`, BID_TYPE_LABELS[x.category], 'bidType', FULL_TILT.bidType,
        { made: x.satisfactory, n: x.total },
        { made: y.satisfactory, n: y.total }),
    );
  }

  // ---- conventions: intersection only ----
  // A convention one player has never called is not a loss, so it does not
  // appear at all — as opposed to appearing and being set aside.
  const convB = new Map(b.conventions.map((x) => [x.family, x]));
  for (const x of a.conventions) {
    const y = convB.get(x.family);
    if (!y) continue;
    out.push(
      rateMeasure(`convention:${x.family}`, CONVENTION_LABELS[x.family], 'convention', FULL_TILT.convention,
        { made: x.satisfactory, n: x.total },
        { made: y.satisfactory, n: y.total }),
    );
  }

  // ---- contract tiers ----
  for (const tier of ['partscore', 'game', 'slam'] as const) {
    out.push(
      rateMeasure(`contract:${tier}`, tier.toUpperCase(), 'contract', FULL_TILT.contract,
        { made: a.contractMix[tier].made, n: a.contractMix[tier].boards },
        { made: b.contractMix[tier].made, n: b.contractMix[tier].boards }),
    );
  }

  return out;
}

/**
 * Rows shown without a verdict, ever.
 *
 * Volume is not skill — playing more boards is not being better at them — and a
 * maximum has no error term to test against, so `bestPct` cannot be judged even
 * in principle. Trick delta has no winner at all: nearer zero is not better,
 * since overtricks earn matchpoints. They are here so a reader can weigh
 * everything above them.
 */
export function buildContext(a: PlayerStats, b: PlayerStats): ContextRow[] {
  return [
    { key: 'bestPct', label: 'BEST CROSSING', a: a.totals.bestPct?.pct ?? null, b: b.totals.bestPct?.pct ?? null, unit: 'pct1' },
    { key: 'boards', label: 'BOARDS PLAYED', a: a.totals.boardsCompleted, b: b.totals.boardsCompleted, unit: 'count' },
    { key: 'crossings', label: 'CROSSINGS', a: a.totals.tournamentsCompleted, b: b.totals.tournamentsCompleted, unit: 'count' },
    { key: 'trickDelta', label: 'TRICK DELTA', a: a.trickDelta.avgDelta, b: b.trickDelta.avgDelta, unit: 'delta' },
  ];
}

/** How the beam's verdicts add up, for the summary chips. */
export function tally(measures: Measure[]): { you: number; them: number; level: number; aside: number } {
  return {
    you: measures.filter((m) => m.verdict === 'you').length,
    them: measures.filter((m) => m.verdict === 'them').length,
    level: measures.filter((m) => m.verdict === 'level').length,
    aside: measures.filter((m) => m.verdict === 'aside').length,
  };
}

export interface CompareSide {
  id: number;
  handle: string;
  picture: string | null;
  kind: 'human' | 'ai';
  boards: number;
}

export interface CompareView {
  you: CompareSide;
  them: CompareSide;
  /** both sides cleared COMPARE_MIN_BOARDS; everything below is empty when false */
  eligible: boolean;
  minBoards: number;
  /** null when the two have never shared a crossing — `commonGround` stands in */
  headToHead: PairRecord | null;
  commonGround: CommonGroundRow[] | null;
  measures: Measure[];
  context: ContextRow[];
  tally: ReturnType<typeof tally>;
}

/**
 * The whole payload, in one pass.
 *
 * Two things about the ordering here are deliberate. Eligibility is settled
 * with two cheap COUNTs BEFORE anything expensive runs, so a thin pair (or
 * someone poking the endpoint directly) can never trigger two full profile
 * builds. And both profiles are built through a SINGLE `memoizedStandings()`
 * closure, which is the whole reason this is one endpoint rather than two calls
 * from the client: `fieldPercentiles` sweeps and matchpoints every standard
 * tournament in the database, and sharing the closure means that happens once
 * rather than twice.
 *
 * Returns null when either id is not a player — the caller decides whether that
 * is a 404 or a silence.
 */
export function buildCompare(
  youId: number,
  themId: number,
  opts: { provisionalMin: number; minBoards: number },
): CompareView | null {
  const youWho = playerIdentity(youId);
  const themWho = playerIdentity(themId);
  if (!youWho || !themWho) return null;

  const you: CompareSide = { ...youWho, boards: completedBoardCount(youId) };
  const them: CompareSide = { ...themWho, boards: completedBoardCount(themId) };
  const empty = { headToHead: null, commonGround: null, measures: [], context: [], tally: tally([]) };

  if (you.boards < opts.minBoards || them.boards < opts.minBoards) {
    return { you, them, eligible: false, minBoards: opts.minBoards, ...empty };
  }

  const getStandings = memoizedStandings();
  const a = playerStats(youId, getStandings);
  const b = playerStats(themId, getStandings);
  if (!a || !b) return null;

  const h2h = pairRecord(youId, themId, getStandings);
  const measures = buildMeasures(a, b, opts.provisionalMin);

  return {
    you,
    them,
    eligible: true,
    minBoards: opts.minBoards,
    headToHead: h2h.shared > 0 ? h2h : null,
    commonGround: h2h.shared > 0 ? null : commonGround(youId, themId, getStandings),
    measures,
    context: buildContext(a, b),
    tally: tally(measures),
  };
}
