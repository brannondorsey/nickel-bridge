#!/usr/bin/env node
/**
 * calibrate_elo.mjs — sweep the PROVISIONAL dials in packages/core/src/elo.ts
 * against a real (or synthetic) tournament history.
 *
 * This is the Elo equivalent of tools/calibrate_k.mjs: the dials it measures
 * change everyone's rating, so pick their values from a replay rather than
 * from taste. Build first (`npm run build`) — it imports the built core.
 *
 *   node tools/calibrate_elo.mjs --synthetic
 *   node tools/calibrate_elo.mjs --input /path/to/replay-inputs.json
 *
 * THE INPUT FILE is an anonymized export of the replay's own inputs. It is
 * deliberately not checked in and not produced by this tool: reading it means
 * touching the production database, which has exactly one supported path (the
 * read-only Fly exec in .claude/skills/player-outreach/). Export it to the
 * session scratchpad, never into this repo — and note that even though the
 * shape below carries no names or emails, it is still production data.
 *
 *   {
 *     "today":      "<unix seconds>",
 *     "tournaments": [{ "id": 1 }, ...],                 // standard only, id order
 *     "boards":      [{ "tournament_id", "user_id", "board_no", "score_ns" }, ...],
 *                                                        // state='done', humans only
 *     "lastBoard":   [{ "user_id", "last" }, ...]        // MAX(updated_at) per human
 *   }
 *
 * The replay below re-derives matchpoints from `boards` with core's own
 * `matchpoints`, exactly as eloParticipants() does, so the sweep measures the
 * real function rather than a paraphrase of it.
 */
import { ELO_INITIAL, PROVISIONAL, eloUpdates, matchpoints } from '../packages/core/dist/index.js';

const BOARDS_PER_TOURNAMENT = 4;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * How long a player must be quiet before this tool counts them as gone.
 *
 * Worth tuning rather than fixing, and the reason is the finding itself: on
 * the production history this was first run against, every one-and-done
 * account was only 4-8 days idle, so a 14-day threshold reported a cohort of
 * zero and made the whole problem look imaginary. A short threshold
 * overstates churn (some of those people come back); a long one understates
 * it on a young database. Run it at both.
 */
const QUIET_DAYS = Number(argValue('--quiet-days') ?? 14);

/**
 * Candidate configs. `today` is the shipped-before-this-change behavior —
 * classic single-K Elo — and is the baseline every other row is read against.
 */
const CANDIDATES = [
  { label: 'today (classic Elo)', provisional: null },
  { label: 'damp 0.5 only', provisional: { TOURNAMENTS: 4, SELF_K_MULT: 1, OPPONENT_DAMP: 0.5 } },
  { label: 'damp 0.25 only', provisional: { TOURNAMENTS: 4, SELF_K_MULT: 1, OPPONENT_DAMP: 0.25 } },
  // SYMMETRIC: self == damp, so both sides of every pairing carry the same K
  // and the whole system stays strictly zero-sum. Shrinking a provisional
  // player's OWN K is the opposite of what Glicko/Kalman prescribe for
  // estimation (an uncertain prior should update faster), but this app is not
  // optimizing estimation for someone who never returns — it is minimizing
  // the rating they strand on the way out.
  { label: 'symmetric 0.75', provisional: { TOURNAMENTS: 4, SELF_K_MULT: 0.75, OPPONENT_DAMP: 0.75 } },
  { label: 'symmetric 0.5', provisional: { TOURNAMENTS: 4, SELF_K_MULT: 0.5, OPPONENT_DAMP: 0.5 } },
  { label: 'symmetric 0.25', provisional: { TOURNAMENTS: 4, SELF_K_MULT: 0.25, OPPONENT_DAMP: 0.25 } },
  { label: 'shipped (whatever is in core)', provisional: { ...PROVISIONAL } },
  { label: 'symmetric 0.5, window 2', provisional: { TOURNAMENTS: 2, SELF_K_MULT: 0.5, OPPONENT_DAMP: 0.5 } },
  { label: 'symmetric 0.5, window 8', provisional: { TOURNAMENTS: 8, SELF_K_MULT: 0.5, OPPONENT_DAMP: 0.5 } },
  { label: 'self 0.5 only', provisional: { TOURNAMENTS: 4, SELF_K_MULT: 0.5, OPPONENT_DAMP: 1 } },
  // The USCF-style dial, kept in the sweep so its rejection stays reproducible
  // rather than becoming folklore in a doc comment — see PROVISIONAL in elo.ts.
  { label: 'self 2x only (REJECTED)', provisional: { TOURNAMENTS: 4, SELF_K_MULT: 2, OPPONENT_DAMP: 1 } },
  { label: 'self 2x + damp 0.5 (REJECTED)', provisional: { TOURNAMENTS: 4, SELF_K_MULT: 2, OPPONENT_DAMP: 0.5 } },
];

/** Mirrors server/src/tournaments.ts's eloParticipants(): human, done, all 4 boards. */
function participantsByTournament(data) {
  const byTournament = new Map();
  for (const b of data.boards) {
    if (!byTournament.has(b.tournament_id)) byTournament.set(b.tournament_id, []);
    byTournament.get(b.tournament_id).push(b);
  }
  const out = new Map();
  for (const { id } of data.tournaments) {
    const rows = byTournament.get(id) ?? [];
    const pcts = new Map();
    for (let no = 1; no <= BOARDS_PER_TOURNAMENT; no++) {
      const boardRows = rows.filter((r) => r.board_no === no);
      const mps = matchpoints(boardRows.map((r) => r.score_ns ?? 0));
      boardRows.forEach((r, i) => {
        if (!pcts.has(r.user_id)) pcts.set(r.user_id, []);
        pcts.get(r.user_id).push(mps[i].pct);
      });
    }
    const complete = [...pcts.entries()]
      .filter(([, p]) => p.length >= BOARDS_PER_TOURNAMENT)
      .map(([userId, p]) => ({ userId, totalPct: p.reduce((a, b) => a + b, 0) / p.length }));
    out.set(id, complete);
  }
  return out;
}

/** One full replay under a candidate config. Mirrors recomputeElo() exactly. */
function replay(data, byTournament, provisional) {
  const ratings = new Map();
  const rated = new Map();
  const history = [];
  for (const { id } of data.tournaments) {
    const complete = byTournament.get(id) ?? [];
    if (complete.length < 2) continue;
    const participants = complete.map((s) => ({
      userId: s.userId,
      rating: ratings.get(s.userId) ?? ELO_INITIAL,
      totalPct: s.totalPct,
      priorTournaments: rated.get(s.userId) ?? 0,
    }));
    for (const r of eloUpdates(participants, { provisional })) {
      ratings.set(r.userId, r.after);
      rated.set(r.userId, (rated.get(r.userId) ?? 0) + 1);
      history.push({ tournamentId: id, userId: r.userId, before: r.before, after: r.after });
    }
  }
  return { ratings, rated, history };
}

function analyze(data, base, run) {
  const { ratings, rated, history } = run;

  // The one-and-done cohort: exactly one rated tournament, and quiet since.
  const lastByUser = new Map(data.lastBoard.map((r) => [r.user_id, Number(r.last)]));
  const oneAndDone = new Set(
    [...rated.entries()]
      .filter(([userId, n]) => {
        if (n !== 1) return false;
        const last = lastByUser.get(userId);
        return last !== undefined && (Number(data.today) - last) / 86400 >= QUIET_DAYS;
      })
      .map(([userId]) => userId),
  );

  const established = [...rated.entries()].filter(([, n]) => n >= PROVISIONAL.TOURNAMENTS).map(([u]) => u);
  const establishedSet = new Set(established);

  // Rating mass that left with players who never came back.
  const massHeldByLeavers = [...oneAndDone].reduce((s, u) => s + (ratings.get(u) - ELO_INITIAL), 0);

  // Every delta an established player took in a tournament that contained at
  // least one one-and-done account — the exposure this change exists to bound.
  const byTournament = new Map();
  for (const h of history) {
    if (!byTournament.has(h.tournamentId)) byTournament.set(h.tournamentId, []);
    byTournament.get(h.tournamentId).push(h);
  }
  let exposedDeltaAbs = 0;
  let worstSwing = 0;
  for (const rows of byTournament.values()) {
    if (!rows.some((r) => oneAndDone.has(r.userId))) continue;
    for (const r of rows) {
      if (!establishedSet.has(r.userId)) continue;
      const d = r.after - r.before;
      exposedDeltaAbs += Math.abs(d);
      worstSwing = Math.max(worstSwing, Math.abs(d));
    }
  }

  // Zero-sum drift: total rating in the pool vs. what classic Elo conserves.
  const totalDrift = [...ratings.values()].reduce((s, r) => s + r - ELO_INITIAL, 0);

  // Convergence cost, for players who STAYED. Shrinking a provisional
  // player's own K buys less stranded rating at the price of a slower climb
  // to their true strength, and that price is only paid by people who keep
  // playing — so it has to be measured on them specifically. For each player
  // with a long record, how far was their rating from where it ended up, at
  // the moment they left the provisional window? Bigger = slower convergence.
  const LONG_RECORD = 8;
  const seriesByUser = new Map();
  for (const h of history) {
    if (!seriesByUser.has(h.userId)) seriesByUser.set(h.userId, []);
    seriesByUser.get(h.userId).push(h.after);
  }
  const gaps = [];
  for (const [userId, series] of seriesByUser) {
    if (series.length < LONG_RECORD) continue;
    const atWindowEnd = series[Math.min(PROVISIONAL.TOURNAMENTS, series.length) - 1];
    gaps.push(Math.abs(atWindowEnd - ratings.get(userId)));
  }
  const convergenceGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;

  // Ladder churn vs. the baseline run, among leaderboard-eligible players only.
  const order = (r, who) => who.slice().sort((a, b) => r.get(b) - r.get(a));
  const eligible = established.filter((u) => (base.rated.get(u) ?? 0) >= PROVISIONAL.TOURNAMENTS);
  const baseOrder = order(base.ratings, eligible);
  const thisOrder = order(ratings, eligible);
  const rankSwaps = baseOrder.filter((u, i) => thisOrder[i] !== u).length;
  const maxRatingShift = eligible.reduce(
    (m, u) => Math.max(m, Math.abs((ratings.get(u) ?? 0) - (base.ratings.get(u) ?? 0))),
    0,
  );

  return {
    oneAndDone: oneAndDone.size,
    massHeldByLeavers,
    exposedDeltaAbs,
    worstSwing,
    totalDrift,
    rankSwaps,
    maxRatingShift,
    convergenceGap,
    eligible: eligible.length,
  };
}

/**
 * A deterministic fake history, so the tool runs for anyone without production
 * access. Deliberately built with the shape being studied: a stable core of
 * regulars plus a stream of accounts that play exactly one tournament.
 */
function synthetic() {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const tournaments = [];
  const boards = [];
  const lastBoard = [];
  const regulars = [1, 2, 3, 4, 5];
  for (const u of regulars) lastBoard.push({ user_id: u, last: 1_800_000_000 });
  let nextNewcomer = 100;
  for (let t = 1; t <= 40; t++) {
    tournaments.push({ id: t });
    const field = regulars.filter(() => rnd() < 0.6);
    if (field.length < 2) field.push(regulars[0], regulars[1]);
    const newcomers = rnd() < 0.6 ? [nextNewcomer++] : [];
    for (const u of newcomers) lastBoard.push({ user_id: u, last: 1_700_000_000 });
    for (const u of [...field, ...newcomers]) {
      // Regulars are genuinely stronger; newcomers are pure noise.
      const strength = regulars.includes(u) ? 100 + u * 30 : 60;
      for (let b = 1; b <= BOARDS_PER_TOURNAMENT; b++) {
        boards.push({ tournament_id: t, user_id: u, board_no: b, score_ns: Math.round(strength + rnd() * 400) });
      }
    }
  }
  return { today: String(1_800_000_000 + 86400 * 30), tournaments, boards, lastBoard };
}

const inputPath = argValue('--input');
let data;
if (inputPath) {
  const { readFileSync } = await import('node:fs');
  data = JSON.parse(readFileSync(inputPath, 'utf8'));
} else if (process.argv.includes('--synthetic')) {
  data = synthetic();
} else {
  console.error('pass --input <file> or --synthetic (see this file\'s header)');
  process.exit(1);
}

const byTournament = participantsByTournament(data);
const base = replay(data, byTournament, null);

console.log(
  `${data.tournaments.length} tournaments, ${new Set(data.boards.map((b) => b.user_id)).size} humans with ` +
    `completed boards, ${base.history.length} rating events\n`,
);

const header = [
  'config'.padEnd(30),
  'drift'.padStart(7),
  'leaver mass'.padStart(12),
  'exposed |Δ|'.padStart(12),
  'worst'.padStart(6),
  'conv'.padStart(6),
  'shift'.padStart(6),
  'swaps'.padStart(6),
].join(' ');
console.log(header);
console.log('-'.repeat(header.length));

for (const c of CANDIDATES) {
  const run = replay(data, byTournament, c.provisional);
  const a = analyze(data, base, run);
  console.log(
    [
      c.label.padEnd(30),
      a.totalDrift.toFixed(0).padStart(7),
      a.massHeldByLeavers.toFixed(0).padStart(12),
      a.exposedDeltaAbs.toFixed(0).padStart(12),
      a.worstSwing.toFixed(0).padStart(6),
      a.convergenceGap.toFixed(0).padStart(6),
      a.maxRatingShift.toFixed(0).padStart(6),
      String(a.rankSwaps).padStart(6),
    ].join(' '),
  );
}

console.log(`
  drift        total rating in the pool minus ${ELO_INITIAL}/player. 0 = strictly zero-sum.
  leaver mass  rating held by one-and-done accounts (quiet ${QUIET_DAYS}+ days) — permanently
               out of circulation. Closer to 0 is better.
  exposed |Δ|  summed |rating change| taken by ESTABLISHED players in tournaments that
               contained a one-and-done account. This is the exposure being bounded.
  worst        largest single-tournament swing for an established player in those.
  conv         for players who STAYED (8+ rated tournaments), mean distance from
               their final rating at the moment they left the provisional window.
               This is the price of shrinking a newcomer's own K — a slower climb
               for the people who keep playing. Lower is better.
  shift        largest rating move vs. the classic-Elo baseline, ladder-eligible players.
  swaps        ladder positions that differ from the classic-Elo baseline.
`);
