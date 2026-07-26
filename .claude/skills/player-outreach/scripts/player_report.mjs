#!/usr/bin/env node
/**
 * player_report.mjs — read-only roster + cohort report for Nickel Bridge outreach.
 *
 * There is no admin API and no analytics pipeline: the only source of truth for
 * "who plays this game" is the production SQLite file on the single Fly machine
 * (see CLAUDE.md's "Deployment shape" — one container, one volume, no replicas).
 * So this script reaches the DB the only way that exists: it asks the Fly
 * Machines API to exec a short Node program *on* the production machine, which
 * opens `/data/bridge.db` with better-sqlite3 in `readonly: true` mode and
 * prints JSON to stdout.
 *
 * Safety properties, in order of how much they matter:
 *   1. The remote payload opens the DB `{ readonly: true }`. SQLite itself
 *      rejects any write on that handle, so a typo in the SQL cannot mutate
 *      production. This is the load-bearing guarantee — keep it.
 *   2. The SQL is a single SELECT defined below and is not built from argv, so
 *      there is no injection surface from flags.
 *   3. Nothing is written back to the machine except a temp file under /tmp
 *      holding the payload itself.
 *
 * Requires FLY_API_TOKEN in the environment (present in Claude Code's remote
 * environment for this repo; not something a normal `npm run` has). That is why
 * this lives in a skill rather than in tools/ — it is operator tooling, not part
 * of the build.
 *
 * Usage:
 *   node player_report.mjs                     # summary + cohorts to stdout
 *   node player_report.mjs --json out.json     # machine-readable, for the skill
 *   node player_report.mjs --csv roster.csv    # full roster spreadsheet
 *   node player_report.mjs --app nickel-bridge-demo   # point at another app
 *   node player_report.mjs --exclude a@b.com,c@d.com  # extra addresses to skip
 *
 * Output contains real users' email addresses. Treat every output path as PII:
 * write it to the session scratchpad, never to the repo, and never to an
 * Artifact or any other shareable surface.
 */

const APP = argValue('--app') ?? 'nickel-bridge';
const JSON_OUT = argValue('--json');
const CSV_OUT = argValue('--csv');
const TOKEN = process.env.FLY_API_TOKEN;

/**
 * The operator's own account. Brannon plays his own game constantly (he is
 * comfortably the top row by board count), so without this he lands in the
 * `retained` cohort every single week and the outreach step would cheerfully
 * draft him a "what's keeping you playing?" email. Excluded rows still appear
 * in the roster and totals — they are real players — they just carry
 * `excluded: true` so the drafting step skips them.
 */
const DEFAULT_EXCLUDE = ['brannon@brannondorsey.com'];
const EXCLUDE = new Set(
  [...DEFAULT_EXCLUDE, ...(argValue('--exclude')?.split(',') ?? [])].map((e) => e.trim().toLowerCase()).filter(Boolean),
);

if (!TOKEN) {
  console.error('FLY_API_TOKEN is not set — this script only runs in an environment that has it.');
  process.exit(1);
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const api = (path, init = {}) =>
  fetch(`https://api.machines.dev/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

/**
 * The cohort query.
 *
 * Two board counts matter and they are NOT the same number, which is the whole
 * reason this is worth writing down:
 *
 *   boards_done       — completed boards (`state = 'done'`), the intuitive
 *                       "how much have they played" measure.
 *   rated_tournaments — rows in elo_history, which is what actually gates the
 *                       leaderboard (`PROVISIONAL_MIN_TOURNAMENTS = 4` in
 *                       server/src/tournaments.ts). A tournament only rates a
 *                       player who finished ALL FOUR of its boards, in a
 *                       tournament where 2+ humans did the same
 *                       (`eloParticipants`). So 16 completed boards spread
 *                       across six half-finished tournaments earns zero rated
 *                       tournaments and no leaderboard row.
 *
 * `on_leaderboard` is therefore the honest "did they reach the ranked list"
 * flag, and it is what the outreach cohorts should reason about. boards_done is
 * kept because it is the number a human intuitively means by "played 16 boards".
 *
 * Exhibit tournaments (demo mode) are excluded from tournament counts the same
 * way the real leaderboard query excludes them.
 */
const SQL = `
  SELECT
    u.id                AS id,
    u.email             AS email,
    u.name              AS name,
    u.handle            AS handle,
    u.elo               AS elo,
    date(u.created_at, 'unixepoch')                     AS signed_up,
    (SELECT COUNT(*) FROM boards b
      WHERE b.user_id = u.id AND b.state = 'done')      AS boards_done,
    (SELECT COUNT(*) FROM boards b
      WHERE b.user_id = u.id)                           AS boards_started,
    (SELECT COUNT(*) FROM elo_history h
      WHERE h.user_id = u.id)                           AS rated_tournaments,
    (SELECT COUNT(DISTINCT b.tournament_id) FROM boards b
       JOIN tournaments t ON t.id = b.tournament_id AND t.kind = 'standard'
      WHERE b.user_id = u.id)                           AS tournaments_touched,
    (SELECT COUNT(DISTINCT date(b.updated_at, 'unixepoch')) FROM boards b
      WHERE b.user_id = u.id)                           AS days_seen,
    (SELECT date(MAX(b.updated_at), 'unixepoch') FROM boards b
      WHERE b.user_id = u.id)                           AS last_seen,
    (SELECT date(MIN(b.updated_at), 'unixepoch') FROM boards b
      WHERE b.user_id = u.id)                           AS first_seen
  FROM users u
  WHERE u.kind = 'human' AND u.email IS NOT NULL
  ORDER BY u.id
`;

// Runs on the production machine. Read-only handle; prints JSON on stdout.
const REMOTE = `
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database(process.env.DB_PATH || '/data/bridge.db', { readonly: true, fileMustExist: true });
const rows = db.prepare(${JSON.stringify(SQL)}).all();
const today = db.prepare("SELECT date('now') AS d").get().d;
console.log(JSON.stringify({ today, rows }));
`;

/**
 * Machine ids are not stable — every deploy replaces them — so resolve one at
 * run time rather than hardcoding. Prefer a machine that is already started;
 * `exec` needs a running machine, and Fly's autostop policy suspends this app
 * whenever traffic is idle, which is most of the time.
 */
async function resolveMachine() {
  const res = await api(`/apps/${APP}/machines`);
  if (!res.ok) throw new Error(`listing machines failed: ${res.status} ${await res.text()}`);
  const machines = await res.json();
  if (!machines.length) throw new Error(`app ${APP} has no machines`);
  return machines.find((m) => m.state === 'started') ?? machines[0];
}

/**
 * A suspended machine can't exec. Rather than force a start through the API
 * (which risks fighting the autostop policy and leaving it running), just make
 * an ordinary HTTPS request — the Fly proxy's `autostart` wakes it exactly the
 * way a real player's first page load does, and it suspends again on its own.
 */
async function wake(machine) {
  if (machine.state === 'started') return machine;
  await fetch(`https://${APP}.fly.dev/health`, { signal: AbortSignal.timeout(30_000) }).catch(() => {});
  for (let i = 0; i < 10; i++) {
    const res = await api(`/apps/${APP}/machines/${machine.id}`);
    const m = await res.json();
    if (m.state === 'started') return m;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`machine ${machine.id} did not start`);
}

async function fetchRows(machine) {
  const b64 = Buffer.from(REMOTE, 'utf8').toString('base64');
  const res = await api(`/apps/${APP}/machines/${machine.id}/exec`, {
    method: 'POST',
    body: JSON.stringify({
      cmd: `sh -c "echo ${b64} | base64 -d > /tmp/nb_report.cjs && node /tmp/nb_report.cjs; rm -f /tmp/nb_report.cjs"`,
      timeout: 30,
    }),
  });
  if (!res.ok) throw new Error(`exec failed: ${res.status} ${await res.text()}`);
  const out = await res.json();
  if (out.exit_code !== 0) throw new Error(`remote query failed (${out.exit_code}): ${out.stderr}`);
  return JSON.parse(out.stdout);
}

/**
 * Cohort assignment.
 *
 * `retained` is deliberately checked first, because the two definitions the
 * outreach cares about overlap: someone with 5 boards across 3 days satisfies
 * both "fewer than 16 boards" and "came back on 2+ days". Returning on a second
 * day is the stronger signal about what the person actually experienced — they
 * chose to come back — so it wins, and `friction` is left as the clean
 * complement: tried it, on a single day, and never returned.
 *
 * `never_played` (signed up, zero completed boards) is reported but gets no
 * email: they have no experience of the game to report on, and asking "why did
 * you stop" of someone who never started reads as a misfire. They are the
 * signup-to-first-board funnel, a different question.
 */
const RETAINED_BOARDS = 16; // ≈ the 4 rated tournaments the leaderboard needs
const RETAINED_DAYS = 2;

function cohortOf(p) {
  if (p.boards_done === 0) return 'never_played';
  if (p.boards_done >= RETAINED_BOARDS || p.days_seen >= RETAINED_DAYS || p.on_leaderboard) return 'retained';
  return 'friction';
}

const machine = await wake(await resolveMachine());
const { today, rows } = await fetchRows(machine);

const players = rows.map((r) => {
  const p = { ...r, on_leaderboard: r.rated_tournaments >= 4, excluded: EXCLUDE.has((r.email ?? '').toLowerCase()) };
  return { ...p, cohort: cohortOf(p) };
});

// Cohort totals count only mailable rows, since the totals exist to answer
// "how many emails is this week?" — the operator's own account is not one.
const byCohort = (c) => players.filter((p) => p.cohort === c && !p.excluded);
const report = {
  generated_on: today,
  app: APP,
  machine: machine.id,
  totals: {
    players: players.length,
    excluded: players.filter((p) => p.excluded).length,
    retained: byCohort('retained').length,
    friction: byCohort('friction').length,
    never_played: byCohort('never_played').length,
    on_leaderboard: players.filter((p) => p.on_leaderboard).length,
  },
  players,
};

if (JSON_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
}

if (CSV_OUT) {
  const { writeFileSync } = await import('node:fs');
  const cols = [
    'id', 'email', 'name', 'handle', 'cohort', 'excluded', 'boards_done', 'boards_started',
    'days_seen', 'last_seen', 'first_seen', 'signed_up', 'rated_tournaments', 'on_leaderboard',
    'tournaments_touched', 'elo',
  ];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  writeFileSync(CSV_OUT, [cols.join(','), ...players.map((p) => cols.map((c) => esc(p[c])).join(','))].join('\n') + '\n');
}

if (!JSON_OUT && !CSV_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const t = report.totals;
  console.error(
    `${report.generated_on}  ${t.players} players — ` +
      `${t.retained} retained, ${t.friction} friction, ${t.never_played} never played ` +
      `(${t.on_leaderboard} on leaderboard)`,
  );
  if (JSON_OUT) console.error(`json → ${JSON_OUT}`);
  if (CSV_OUT) console.error(`csv  → ${CSV_OUT}`);
}
