#!/usr/bin/env node
/**
 * calibrate_placement.mjs — replay real placement demand through candidate
 * placement policies and score the outcomes.
 *
 * WHY THIS EXISTS. The placement knobs in server/src/tournaments.ts (PLACEMENT,
 * chooseTournament) were set for a population that does not exist yet, and at
 * today's scale two of them are actively harmful: the grace tier drains
 * oldest-first, which starves the freshest tournaments when one player
 * out-produces everyone else, and SAMPLE_RATIO deliberately SPREADS
 * simultaneous arrivals when what a five-player site needs is for them to pile
 * onto one board. Changing either is a guess unless it is measured, and the
 * thing to measure it against is what people actually did.
 *
 * WHICH NUMBER TO READ. `meanField` is NOT it, and cannot be improved: a player
 * may never be placed into a tournament they have already played, so the
 * tournament count is floored at `max demands by any single player`, and
 * production sits exactly on that floor (90 of 90). Mean field is pinned for
 * every policy that doesn't create MORE tournaments than necessary.
 *
 * Read `fieldSeen` and `soloCrossings` instead, which measure the two things
 * players actually feel:
 *
 *   fieldSeen  sum(f^2)/sum(f) — the field size at the average CROSSING rather
 *              than the average tournament. A 7-human board gives seven people
 *              a big field; a solo board gives one person none. This is the
 *              "fun to see how you did against others" number.
 *   soloPct    share of crossings that ended with nobody to compare against.
 *   span h     median hours between the first and last player arriving at a
 *              board — the "did we play this around the same time" number,
 *              which is what makes a board worth talking about.
 *
 * fieldSeen turns out to be nearly INELASTIC: every ordering lands between 3.6
 * and 4.1, because the total is fixed and only its concentration can move. Solo
 * rate and span are elastic — roughly 2x between the best and worst ordering. So
 * the honest framing is: field depth is close to whatever you do, pick the
 * ordering that fixes loneliness and co-presence without spending depth to do it.
 *
 * WHAT IS REPLAYED. A "demand" is one moment a player wanted a crossing and
 * had none to resume: exactly the distinct (player, tournament) pairs in the
 * database, since resuming never creates a new pair. The trace carries
 * (time, player, spanS, done) and no identity. Timings are treated as
 * INVARIANT under policy — people sit down to play when they have time, not
 * because a particular tournament exists. That is the load-bearing assumption
 * of the whole exercise; it is sound for "which tournament do they land in"
 * and would NOT be sound for anything claiming a policy changes how often
 * people play.
 *
 * The `current` policy is not a reimplementation — it calls the real
 * chooseTournament out of the built server, so the baseline cannot drift from
 * production by transcription error. That is also why this tool needs
 * `npm run build` first, and why it points DB_PATH at a throwaway file: that
 * module opens SQLite at import time and we want nothing to do with a real one.
 *
 * Usage:
 *   node tools/calibrate_placement.mjs --trace trace.json            # compare policies
 *   node tools/calibrate_placement.mjs --trace trace.json --sweep tau
 *   node tools/calibrate_placement.mjs --trace trace.json --policy fullest,deficit,lastResort
 *   node tools/calibrate_placement.mjs --synthetic --days 90         # no trace needed
 *
 * WHAT THIS TOOL CANNOT ANSWER: anything about BACKLOG_WINDOW_S. The captured
 * trace is ~21 days long and production's oldest tournament is younger than
 * the 30-day window, so no replay of real demand ever reaches it — `--sweep
 * window` returns identical rows for 30d and 60d for that reason, not because
 * the knob is harmless. `--synthetic --days 90` reaches it and still shows
 * nothing, because the window only constrains the SCORING tier (grace already
 * requires under-48h) and that tier decides ~11% of real placements.
 *
 * The window is better reasoned about than simulated, and the arithmetic says
 * it is nearly redundant: TAU_S is also 30 days, so a candidate's score
 * log(1+finishers)·e^(-age/TAU) crosses the ln 2 join threshold at
 * TAU·ln(ln(1+finishers)/ln 2) — 13.8 days at 2 finishers, 20.8 at 3, 25.3 at
 * 4, 28.5 at 5. The decay expires everything below SIX finishers before the
 * window ever sees it, so the hard cutoff bites only the most popular
 * tournaments, i.e. exactly the ones worth joining for field size. One soft
 * slope and one hard cliff at the same distance is a duplicated knob; if these
 * are ever retuned, let TAU express the recency preference and make the window
 * a loose sanity bound rather than a second, blunter copy of it.
 */
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'nb-calib-')), 'throwaway.db');
process.env.AI_PLAYERS = '0';
const { chooseTournament, PLACEMENT } = await import('../server/dist/tournaments.js');

const DAY = 86400;
const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? dflt : process.argv[i + 1];
};
const has = (flag) => process.argv.includes(flag);

/** Deterministic PRNG so a policy's weighted sampling is reproducible run to run. */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A policy is the five decisions chooseTournament makes, each pulled out as a
 * knob. `current` reproduces production exactly by delegating to the real
 * function; every other combination is evaluated here.
 */
const DEFAULTS = {
  graceOrder: 'oldest', //  oldest | fullest   (fullest = most starters, then freshest)
  score: 'popularity', //   popularity | deficit
  create: 'threshold', //   threshold | lastResort
  spread: true, //          weighted-sample near the top (SAMPLE_RATIO) vs argmax
  tauD: PLACEMENT.TAU_S / DAY,
  windowD: PLACEMENT.BACKLOG_WINDOW_S / DAY,
  graceTtlH: PLACEMENT.GRACE_TTL_S / 3600,
  graceCap: PLACEMENT.GRACE_CAP,
  /** deficit scoring only: field size past which a tournament stops needing players */
  target: 6,
};

function simulate(trace, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const rng = mulberry32(12345);
  const useReal = o.useReal ?? false;
  const tournaments = []; // { id, createdAt, joins: [{p, at, finishAt, done}] }
  // Which tier decided each placement. Load-bearing diagnostic rather than
  // trivia: a knob in a tier that never runs cannot change any outcome, and
  // three of the four proposed changes live in the scoring tier.
  const via = { grace: 0, score: 0, create: 0 };

  for (const ev of trace.events) {
    const now = ev.t;
    const eligible = tournaments.filter(
      (c) => now - c.createdAt < o.windowD * DAY && !c.joins.some((j) => j.p === ev.p),
    );
    let pick = null;

    if (useReal) {
      // Real production code. Shape the candidates exactly as stmtCandidates does:
      // starters = distinct humans with any board, done_players = distinct
      // humans who have FINISHED (their span has elapsed by now).
      pick = chooseTournament(
        eligible.map((c) => ({
          id: c.id,
          name: `T${c.id}`,
          seed: 's',
          created_at: c.createdAt,
          starters: c.joins.length,
          done_players: c.joins.filter((j) => j.done === 4 && j.finishAt <= now).length,
        })),
        now,
        rng,
      );
      pick = pick ? tournaments.find((c) => c.id === pick.id) : null;
      // The real function doesn't report which tier fired; re-derive it.
      if (pick) {
        const inGrace =
          now - pick.createdAt < PLACEMENT.GRACE_TTL_S && pick.joins.length < PLACEMENT.GRACE_CAP;
        via[inGrace ? 'grace' : 'score']++;
      }
    } else {
      pick = choose(eligible, now, o, rng, via);
    }

    if (!pick) {
      via.create++;
      pick = { id: tournaments.length + 1, createdAt: now, joins: [] };
      tournaments.push(pick);
    }
    pick.joins.push({ p: ev.p, at: now, finishAt: now + ev.spanS, done: ev.done });
  }
  return metrics(trace, tournaments, o, via);
}

/**
 * Grace-tier orderings. Which of these wins is the single most consequential
 * choice in this file, because at production's demand shape the grace tier
 * decides the overwhelming majority of placements — the scoring tier below it
 * barely runs (see the `via` counters in the output).
 *
 * Two intuitions both turn out to be half right, which is why the composite
 * `rescueThenFullest` wins. Plain `fullest` — top up the busiest board — buys
 * the best field depth and the worst loneliness (15 orphans against
 * production's 10), because there is always something fuller to prefer over a
 * board sitting at one player. Plain `emptiest` inverts both: it halves
 * loneliness and gives up the deep fields. Doing the rescue FIRST and then
 * filling costs almost nothing, because the two goals only compete once every
 * board already has a second player.
 */
const ORDERINGS = {
  // Production: FIFO. Starves the tail when demand outruns supply.
  oldest: (a, b) => a.createdAt - b.createdAt || a.id - b.id,
  // Best-fit bin packing. Intuitive, and measurably wrong — see above.
  fullest: (a, b) => b.joins.length - a.joins.length || b.createdAt - a.createdAt || a.id - b.id,
  // Worst-fit: the board that needs a human most, freshest first among equals.
  emptiest: (a, b) => a.joins.length - b.joins.length || b.createdAt - a.createdAt || a.id - b.id,
  // Same, but oldest-first among equally empty boards: rescues the ones about
  // to age out of the window instead of the ones with time left.
  emptiestOldest: (a, b) => a.joins.length - b.joins.length || a.createdAt - b.createdAt || a.id - b.id,
  // Pure LIFO: freshest board regardless of how full, i.e. maximum co-presence.
  freshest: (a, b) => b.createdAt - a.createdAt || a.id - b.id,
  // "Nobody sits alone, then make the parties big": rescue any board stuck at
  // one human first, and otherwise top up the fullest. This is the ordering
  // that serves a LARGE-FIELD objective without paying for it in orphans --
  // the two goals only conflict once every board has a second player.
  rescueThenFullest: (a, b) => {
    const solo = (c) => (c.joins.length === 1 ? 0 : 1);
    return solo(a) - solo(b) || b.joins.length - a.joins.length || b.createdAt - a.createdAt || a.id - b.id;
  },
};

/** The candidate policies, sharing chooseTournament's two-tier shape. */
function choose(eligible, now, o, rng, via) {
  const grace = eligible.filter(
    (c) => now - c.createdAt < o.graceTtlH * 3600 && c.joins.length < o.graceCap,
  );
  if (grace.length) {
    grace.sort(ORDERINGS[o.graceOrder]);
    via.grace++;
    return grace[0];
  }

  const scored = eligible.map((c) => {
    const age = now - c.createdAt;
    const decay = Math.exp(-Math.max(0, age) / (o.tauD * DAY));
    const finishers = new Set(c.joins.filter((j) => j.done === 4 && j.finishAt <= now).map((j) => j.p)).size;
    // popularity: what production uses — rewards a full board, so a 1-finisher
    // tournament scores below the create-new threshold at any age and can never
    // be rescued. deficit: rewards ROOM, so the boards that need players most
    // are the ones offered first.
    const base =
      o.score === 'deficit' ? Math.max(0, o.target - c.joins.length) : Math.log(1 + finishers);
    return { c, score: base * decay };
  });

  const top = scored.reduce((m, x) => Math.max(m, x.score), 0);
  if (o.create === 'threshold') {
    if (top < PLACEMENT.NEW_TOURNAMENT_SCORE) return null;
  } else if (o.create === 'never') {
    // Answers "shouldn't a player always take an existing board over making a
    // new solo one?" directly: create ONLY when there is nothing eligible at
    // all. Note this is stronger than lastResort, which still declines boards
    // scoring zero.
    if (eligible.length) {
      const pick = [...eligible].sort(ORDERINGS[o.graceOrder])[0];
      via.score++;
      return pick;
    }
    return null;
  } else if (top <= 0) {
    return null; // lastResort: create only when nothing joinable is left
  }

  const floor = o.create === 'threshold' ? Math.max(PLACEMENT.SAMPLE_RATIO * top, PLACEMENT.NEW_TOURNAMENT_SCORE) : PLACEMENT.SAMPLE_RATIO * top;
  const pool = scored
    .filter((x) => x.score >= floor)
    .sort((a, b) => b.score - a.score || a.c.createdAt - b.c.createdAt || a.c.id - b.c.id);
  if (!pool.length) return null;
  via.score++;
  if (!o.spread) return pool[0].c; // concentrate: always the best board

  let r = rng() * pool.reduce((s, x) => s + x.score, 0);
  for (const x of pool) {
    r -= x.score;
    if (r < 0) return x.c;
  }
  return pool[pool.length - 1].c;
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function metrics(trace, tournaments, o, via) {
  const fields = tournaments.map((t) => new Set(t.joins.map((j) => j.p)).size);
  const demands = trace.events.length;
  // The floor: a player never replays a tournament, so no policy can use fewer
  // tournaments than the busiest player's demand count.
  const perPlayer = {};
  for (const e of trace.events) perPlayer[e.p] = (perPlayer[e.p] || 0) + 1;
  const floor = Math.max(...Object.values(perPlayer));

  let solo = 0;
  let pairPlus = 0;
  let triPlus = 0;
  const ages = [];
  const spans = [];
  for (const t of tournaments) {
    const n = new Set(t.joins.map((j) => j.p)).size;
    for (const j of t.joins) {
      if (n <= 1) solo++;
      if (n >= 2) pairPlus++;
      if (n >= 3) triPlus++;
      if (j.at > t.createdAt) ages.push((j.at - t.createdAt) / 3600);
    }
    if (t.joins.length > 1) spans.push((Math.max(...t.joins.map((j) => j.at)) - Math.min(...t.joins.map((j) => j.at))) / 3600);
  }
  const hist = {};
  for (const f of fields) hist[f] = (hist[f] || 0) + 1;
  // Field size WEIGHTED BY CROSSING, not by tournament: a 7-human board gives
  // seven people a big field, a solo board gives one person none. This is the
  // number to read for "how many others can I compare against", and it is NOT
  // the same as meanField -- sum(f^2)/sum(f) rewards depth, mean does not.
  const seenAvg = fields.reduce((s2, f) => s2 + f * f, 0) / demands;
  let fourPlus = 0;
  for (const f of fields) if (f >= 4) fourPlus += f;

  return {
    name: o.name ?? 'custom',
    tournaments: tournaments.length,
    floor,
    excess: tournaments.length - floor,
    meanField: +(demands / tournaments.length).toFixed(2),
    orphans: fields.filter((f) => f === 1).length,
    soloCrossings: solo,
    soloPct: +((100 * solo) / demands).toFixed(1),
    pct2plus: +((100 * pairPlus) / demands).toFixed(1),
    pct3plus: +((100 * triPlus) / demands).toFixed(1),
    seenAvg: +seenAvg.toFixed(2),
    pct4plus: +((100 * fourPlus) / demands).toFixed(1),
    medJoinAgeH: +median(ages).toFixed(1),
    medSpanH: +median(spans).toFixed(1),
    viaGrace: via.grace,
    viaScore: via.score,
    viaCreate: via.create,
    hist,
  };
}

/** A trace with no production access: one heavy player plus a light tail. */
function syntheticTrace(days = 21, heavy = 90, others = 12) {
  const events = [];
  for (let i = 0; i < heavy; i++) events.push({ t: Math.floor((i / heavy) * days * DAY), p: 0, spanS: 1800, done: 4 });
  let p = 1;
  for (let k = 0; k < others; k++) {
    const n = 1 + Math.floor(20 / (k + 1));
    for (let i = 0; i < n; i++) {
      events.push({ t: Math.floor(((i + 0.5) / n) * days * DAY) + k * 3600, p, spanS: 2400, done: 4 });
    }
    p++;
  }
  events.sort((a, b) => a.t - b.t);
  return { capturedOn: 'synthetic', players: p, horizonS: days * DAY, events };
}

// ---------------------------------------------------------------- run

const trace = has('--synthetic')
  ? syntheticTrace(Number(arg('--days', 21)))
  : JSON.parse(readFileSync(arg('--trace', 'trace.json'), 'utf8'));

const CURRENT = { name: 'current (production)', useReal: true };
/**
 * The proposal the replay actually supports, as opposed to the one intuition
 * suggested. `emptiest` rather than `fullest` is the whole difference, and it
 * is the opposite of "concentrate players" — see ORDERINGS.
 */
const PROPOSED = {
  name: 'proposed',
  graceOrder: 'emptiest',
  score: 'deficit',
  create: 'lastResort',
  spread: false,
  tauD: 3,
};

const COLS = [
  ['policy', 'name', 24],
  ['tourns', 'tournaments', 7],
  ['+over', 'excess', 6],
  ['orphan', 'orphans', 7],
  ['solo%', 'soloPct', 7],
  ['>=2 hum%', 'pct2plus', 9],
  ['>=3 hum%', 'pct3plus', 9],
  ['>=4 hum%', 'pct4plus', 9],
  ['fieldSeen', 'seenAvg', 10],
  ['joinAge h', 'medJoinAgeH', 10],
  ['span h', 'medSpanH', 7],
  ['grace', 'viaGrace', 6],
  ['score', 'viaScore', 6],
  ['new', 'viaCreate', 5],
];
const header = () => {
  console.log(COLS.map(([h, , w]) => h.padStart(w)).join(' '));
  console.log(COLS.map(([, , w]) => '-'.repeat(w)).join(' '));
};
const row = (m) => console.log(COLS.map(([, k, w]) => String(m[k]).padStart(w)).join(' '));

const perPlayer = trace.events.reduce((a, e) => ((a[e.p] = (a[e.p] || 0) + 1), a), {});
const floor = Math.max(...Object.values(perPlayer));
console.log(
  `\ntrace: ${trace.events.length} demands . ${trace.players} players . ` +
    `${(trace.horizonS / DAY).toFixed(1)}d . captured ${trace.capturedOn}`,
);
console.log(
  `tournament floor (busiest player's demands): ${floor} -> mean field is pinned at ` +
    `${(trace.events.length / floor).toFixed(2)} for any policy at the floor. Read solo%.\n`,
);

/** `--set graceOrder=emptiest,graceTtlH=72` — any knob, for ad-hoc combos. */
function parseSet(s) {
  const o = {};
  for (const kv of s.split(',')) {
    const [k, v] = kv.split('=');
    o[k] = v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v);
  }
  return o;
}

const sweep = arg('--sweep');
if (has('--set')) {
  const o = parseSet(arg('--set'));
  header();
  const base = simulate(trace, CURRENT);
  const got = simulate(trace, { ...PROPOSED, name: arg('--set').slice(0, 24), ...o });
  row(base);
  row(got);
  const h = (m) => Object.entries(m.hist).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join('  ');
  console.log(`\n  current   ${h(base)}\n  candidate ${h(got)}   (humans : tournaments)`);
} else if (sweep === 'frontier') {
  // The actual decision. Orphan elimination and field DEPTH pull against each
  // other: every demand routed to a board sitting at one human is a demand not
  // deepening a board that already has three. There is no setting that wins
  // both, so this prints the frontier and the choice is a judgment call about
  // which failure is worse — a player with nobody to compare against, or a
  // thinner field for everyone.
  header();
  row(simulate(trace, CURRENT));
  for (const [name, o] of [
    ['rescue-then-fill', { graceOrder: 'rescueThenFullest', score: 'popularity', create: 'threshold', tauD: 30 }],
    ['fullest (max depth)', { graceOrder: 'fullest', score: 'popularity', create: 'threshold', tauD: 30 }],
    ['freshest (co-presence)', { graceOrder: 'freshest' }],
    ['emptiest ttl=48h', { graceOrder: 'emptiest' }],
    ['emptiest ttl=72h', { graceOrder: 'emptiest', graceTtlH: 72 }],
    ['emptiest ttl=120h', { graceOrder: 'emptiest', graceTtlH: 120 }],
    ['emptiestOldest ttl=48h', { graceOrder: 'emptiestOldest' }],
    ['+ target=3 (max spread)', { graceOrder: 'emptiest', target: 3 }],
    ['+ target=2 (zero orphan)', { graceOrder: 'emptiest', target: 2 }],
  ]) {
    row(simulate(trace, { ...PROPOSED, name, ...o }));
  }
  console.log('\n  solo% down     = fewer players with nobody to compare against');
  console.log('  fieldSeen up   = more people to compare against at the average crossing');
  console.log('  span h down    = players met closer together in time (worth talking about)');
  console.log('  fieldSeen is nearly inelastic (3.6-4.1); solo% and span are the real levers.');
} else if (sweep === 'grace') {
  // The grace tier decides nearly every placement, so its ordering is the
  // lever. Everything else held at the proposal.
  header();
  row(simulate(trace, CURRENT));
  for (const graceOrder of Object.keys(ORDERINGS)) {
    row(simulate(trace, { ...PROPOSED, name: `grace: ${graceOrder}`, graceOrder }));
  }
} else if (sweep === 'gracecap') {
  header();
  row(simulate(trace, CURRENT));
  for (const graceCap of [2, 3, 4, 5, 6, 8, 99]) {
    row(simulate(trace, { ...PROPOSED, name: `graceCap=${graceCap}`, graceCap }));
  }
} else if (sweep === 'gracettl') {
  header();
  row(simulate(trace, CURRENT));
  for (const graceTtlH of [12, 24, 48, 72, 120, 240]) {
    row(simulate(trace, { ...PROPOSED, name: `graceTTL=${graceTtlH}h`, graceTtlH }));
  }
} else if (sweep === 'tau') {
  header();
  row(simulate(trace, CURRENT));
  for (const tauD of [1, 2, 3, 5, 7, 14, 30]) {
    row(simulate(trace, { ...PROPOSED, name: `tau=${tauD}d`, tauD }));
  }
} else if (sweep === 'window') {
  header();
  row(simulate(trace, CURRENT));
  for (const windowD of [3, 7, 14, 30, 60]) {
    row(simulate(trace, { ...PROPOSED, name: `window=${windowD}d`, windowD }));
  }
} else if (sweep === 'target') {
  header();
  row(simulate(trace, CURRENT));
  for (const target of [2, 3, 4, 6, 8, 12]) {
    row(simulate(trace, { ...PROPOSED, name: `target=${target}`, target }));
  }
} else if (sweep === 'ablate') {
  // One knob at a time reverted from the proposal, so each earns its place.
  header();
  row(simulate(trace, CURRENT));
  row(simulate(trace, PROPOSED));
  row(simulate(trace, { ...PROPOSED, name: '- grace ordering', graceOrder: 'oldest' }));
  row(simulate(trace, { ...PROPOSED, name: '- deficit score', score: 'popularity' }));
  row(simulate(trace, { ...PROPOSED, name: '- last resort', create: 'threshold' }));
  row(simulate(trace, { ...PROPOSED, name: '- concentrate', spread: true }));
  row(simulate(trace, { ...PROPOSED, name: '- tau (keep 30d)', tauD: 30 }));
} else {
  header();
  row(simulate(trace, CURRENT));
  row(simulate(trace, { ...PROPOSED, name: 'grace emptiest only', score: 'popularity', create: 'threshold', spread: true, tauD: DEFAULTS.tauD }));
  row(simulate(trace, { ...PROPOSED, name: 'grace fullest (wrong)', graceOrder: 'fullest' }));
  row(simulate(trace, PROPOSED));
  console.log('\nfield-size histogram (humans : tournaments)');
  for (const [label, o] of [['current ', CURRENT], ['proposed', PROPOSED]]) {
    const m = simulate(trace, o);
    console.log(`  ${label}  ` + Object.entries(m.hist).sort((a,b)=>a[0]-b[0]).map(([k, v]) => `${k}:${v}`).join('  '));
  }
  console.log('\n--sweep grace | gracecap | gracettl | tau | window | target | ablate');
}
