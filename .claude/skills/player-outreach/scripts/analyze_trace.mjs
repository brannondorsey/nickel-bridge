#!/usr/bin/env node
/**
 * analyze_trace.mjs — capture the finished-board trace that
 * tools/calibrate_moment_floor.mjs replays to calibrate Analyze's
 * MOMENT_FLOOR (server/src/analyze.ts) the way FULL_TILT was calibrated for
 * Compare (docs/compare.md): a read-only sweep against real production
 * boards, because the thing MOMENT_FLOOR has to be right-sized for is this
 * app's actual field sizes and score spread, not a guessed distribution.
 *
 * Lives in this skill rather than in tools/ for the same reason
 * player_report.mjs and placement_trace.mjs do: it needs FLY_API_TOKEN and
 * execs on the production machine, and this skill is deliberately the ONE
 * path to production data. The offline sweep it feeds has no network access,
 * so that half stays in tools/ where the other calibrate_* scripts are.
 *
 * Same safety properties as its siblings, and they matter identically here:
 * the remote payload opens /data/bridge.db with `{ readonly: true }`, the SQL
 * is fixed in this file rather than built from argv, and nothing is written
 * on the machine except a /tmp payload it deletes. UNLIKE player_report.mjs
 * this selects no names, handles or email addresses, and unlike
 * placement_trace.mjs it doesn't even carry an anonymized player id: a
 * board's own deal (derived from its tournament's seed + board number),
 * calls, plays and the FIELD's score list are what the calibration needs —
 * nothing here identifies who sat down. Tournament ids are replaced with
 * dense indices below anyway, since nothing about them needs to survive.
 *
 * This is a SECOND production exec beyond player_report.mjs's pre-authorized
 * one, which .claude/CLAUDE.md's "Player outreach" section calls out
 * specifically: it is deliberately NOT covered by .claude/settings.json's
 * autoMode allowance, so running it (here, or by another agent later) should
 * prompt a human first rather than fire unattended.
 *
 * Usage:
 *   node .claude/skills/player-outreach/scripts/analyze_trace.mjs "$SCRATCH/analyze-trace.json"
 *   node tools/calibrate_moment_floor.mjs --trace "$SCRATCH/analyze-trace.json"
 */
const APP = 'nickel-bridge';
const TOKEN = process.env.FLY_API_TOKEN;
const api = (p, i = {}) => fetch(`https://api.machines.dev/v1${p}`, { ...i, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(i.headers ?? {}) } });

if (!TOKEN) {
  console.error('FLY_API_TOKEN is not set — this script only runs in an environment that has it.');
  process.exit(1);
}

// One row per FINISHED board of a STANDARD tournament (kind='standard' —
// excludes exhibits/rehearsals, which Analyze either never serves or never
// scores). userKind is included so the local sweep can treat only human-owned
// boards as "a player opened Analyze here" — a benchmark AI persona's own
// board still counts toward the FIELD (matchpoints score house rows too, see
// CONTRIBUTING.md's "Benchmark AI players"), just never as the viewer.
const REMOTE = `
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database('/data/bridge.db', { readonly: true, fileMustExist: true });
const out = {};
out.today = db.prepare("SELECT strftime('%s','now') AS n").get().n;
out.rows = db.prepare(\`
  SELECT b.tournament_id AS tid, b.board_no AS boardNo, b.calls AS calls, b.plays AS plays,
         b.contract AS contract, b.tricks_declarer AS tricksDeclarer, b.score_ns AS scoreNs,
         b.claimed_at_ply AS claimedAtPly, t.seed AS seed, t.claim_rule AS claimRule,
         u.kind AS userKind
  FROM boards b
  JOIN tournaments t ON t.id = b.tournament_id
  JOIN users u ON u.id = b.user_id
  WHERE b.state = 'done' AND t.kind = 'standard'
  ORDER BY b.tournament_id, b.board_no\`).all();
console.log(JSON.stringify(out));
`;

const ms = await (await api(`/apps/${APP}/machines`)).json();
if (!ms.length) throw new Error(`app ${APP} has no machines`);
let m = ms.find((x) => x.state === 'started') ?? ms[0];
if (m.state !== 'started') {
  await fetch(`https://${APP}.fly.dev/health`).catch(() => {});
  for (let i = 0; i < 15 && m.state !== 'started'; i++) { await new Promise(r => setTimeout(r, 2000)); m = await (await api(`/apps/${APP}/machines/${m.id}`)).json(); }
}
const b64 = Buffer.from(REMOTE, 'utf8').toString('base64');
const r = await api(`/apps/${APP}/machines/${m.id}/exec`, { method: 'POST', body: JSON.stringify({ cmd: `sh -c "echo ${b64} | base64 -d > /tmp/nb_at.cjs && node /tmp/nb_at.cjs; rm -f /tmp/nb_at.cjs"`, timeout: 90 }) });
const o = await r.json();
if (o.exit_code !== 0) { console.error(o.stderr); process.exit(1); }
const raw = JSON.parse(o.stdout);

// Group by (tournament, board) to build each board's FIELD — the score_ns
// list Analyze substitutes a counterfactual into (boardFieldRows' own
// order). Anonymize the tournament id into a dense index; board_no (1..4)
// and everything else here is game state, not identity, so it survives
// verbatim.
const tids = [...new Set(raw.rows.map((r) => r.tid))];
const tIndex = new Map(tids.map((t, i) => [t, i]));
const groups = new Map(); // `${tid}:${boardNo}` -> rows
for (const r of raw.rows) {
  const key = `${r.tid}:${r.boardNo}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

// One entry per HUMAN-owned finished board: its own play plus the field
// (every row on that exact board, house personas included) it was scored
// against — exactly what analyze.ts's computeCore reads to grade it.
const boards = [];
for (const rows of groups.values()) {
  const scores = rows.map((r) => r.scoreNs ?? 0);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.userKind !== 'human') continue;
    boards.push({
      tid: tIndex.get(r.tid),
      boardNo: r.boardNo,
      seed: r.seed,
      claimRule: r.claimRule,
      calls: JSON.parse(r.calls),
      plays: JSON.parse(r.plays),
      contract: r.contract ? JSON.parse(r.contract) : null,
      tricksDeclarer: r.tricksDeclarer,
      claimedAtPly: r.claimedAtPly,
      myIndex: i,
      scores,
    });
  }
}

const trace = {
  capturedOn: new Date(raw.today * 1000).toISOString().slice(0, 10),
  note: 'finished standard-tournament boards, human-owned viewer perspective, field score_ns per board. no names/handles/emails/user ids.',
  boards,
};
const fs = await import('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify(trace, null, 1));
const solo = boards.filter((b) => b.scores.length <= 1).length;
console.error(`${boards.length} human-owned finished boards (${solo} single-field) across ${tids.length} tournaments -> ${process.argv[2]}`);
