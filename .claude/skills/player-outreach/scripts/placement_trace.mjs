#!/usr/bin/env node
/**
 * placement_trace.mjs — capture the placement-demand trace that
 * tools/calibrate_placement.mjs replays.
 *
 * Lives in this skill rather than in tools/ for the same reason
 * player_report.mjs does: it needs FLY_API_TOKEN and execs on the production
 * machine, and this skill is deliberately the ONE path to production data.
 * The simulator it feeds is a pure offline tool with no network access, so
 * that half stays in tools/ where the other calibrate_* scripts are.
 *
 * Same safety properties as player_report.mjs, and they matter identically
 * here: the remote payload opens /data/bridge.db with `{ readonly: true }`, the
 * SQL is fixed in this file rather than built from argv, and nothing is written
 * on the machine except a /tmp payload it deletes.
 *
 * A "demand" is one moment a player wanted a crossing and had no unfinished
 * one to resume — which in the data is exactly the set of distinct
 * (user, tournament) pairs, since resuming never creates a new pair. Timestamp
 * is MIN(boards.updated_at) for that pair: strictly a little AFTER the real
 * placement (updated_at is when their first board of it finished), but biased
 * the same way for every event, which is what matters for a replay.
 *
 * UNLIKE player_report.mjs this selects no names, handles or email addresses —
 * player ids become dense indices and timestamps become offsets from the first
 * event, so the output is arrival timings and nothing else. It is still
 * production data about real people's behaviour, so it goes to the session
 * scratchpad like every other output here, never into this public repo.
 *
 * Usage:
 *   node .claude/skills/player-outreach/scripts/placement_trace.mjs "$SCRATCH/trace.json"
 *   node tools/calibrate_placement.mjs --trace "$SCRATCH/trace.json" --sweep frontier
 */
const APP = 'nickel-bridge';
const TOKEN = process.env.FLY_API_TOKEN;
const api = (p, i = {}) => fetch(`https://api.machines.dev/v1${p}`, { ...i, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(i.headers ?? {}) } });

const REMOTE = `
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database('/data/bridge.db', { readonly: true, fileMustExist: true });
const out = {};
out.today = db.prepare("SELECT strftime('%s','now') AS n").get().n;
out.demands = db.prepare(\`
  SELECT b.tournament_id AS tid, b.user_id AS uid,
         MIN(b.updated_at) AS at,
         SUM(CASE WHEN b.state='done' THEN 1 ELSE 0 END) AS done,
         MAX(b.updated_at) AS last
  FROM boards b JOIN users u ON u.id=b.user_id JOIN tournaments t ON t.id=b.tournament_id
  WHERE u.kind='human' AND t.kind='standard'
  GROUP BY b.tournament_id, b.user_id ORDER BY at\`).all();
out.tournaments = db.prepare(\`
  SELECT id, created_at, difficulty FROM tournaments WHERE kind='standard' ORDER BY id\`).all();
console.log(JSON.stringify(out));
`;

const ms = await (await api(`/apps/${APP}/machines`)).json();
let m = ms.find((x) => x.state === 'started') ?? ms[0];
if (m.state !== 'started') {
  await fetch(`https://${APP}.fly.dev/health`).catch(() => {});
  for (let i = 0; i < 15 && m.state !== 'started'; i++) { await new Promise(r => setTimeout(r, 2000)); m = await (await api(`/apps/${APP}/machines/${m.id}`)).json(); }
}
const b64 = Buffer.from(REMOTE, 'utf8').toString('base64');
const r = await api(`/apps/${APP}/machines/${m.id}/exec`, { method: 'POST', body: JSON.stringify({ cmd: `sh -c "echo ${b64} | base64 -d > /tmp/nb_p4.cjs && node /tmp/nb_p4.cjs; rm -f /tmp/nb_p4.cjs"`, timeout: 60 }) });
const o = await r.json();
if (o.exit_code !== 0) { console.error(o.stderr); process.exit(1); }
const raw = JSON.parse(o.stdout);

// Anonymize: dense player indices, times relative to the first event.
const players = [...new Set(raw.demands.map((d) => d.uid))];
const pIndex = new Map(players.map((u, i) => [u, i]));
const t0 = Math.min(...raw.demands.map((d) => d.at));
const trace = {
  capturedOn: new Date(raw.today * 1000).toISOString().slice(0, 10),
  note: 'placement demands: (player, time) pairs. times are seconds since the first event.',
  horizonS: Math.max(...raw.demands.map((d) => d.at)) - t0,
  players: players.length,
  // Real per-tournament field sizes, to sanity-check the replay against reality.
  actual: { tournaments: raw.tournaments.length, demands: raw.demands.length },
  events: raw.demands
    .map((d) => ({ t: d.at - t0, p: pIndex.get(d.uid), done: d.done, spanS: d.last - d.at }))
    .sort((a, b) => a.t - b.t || a.p - b.p),
};
const fs = await import('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify(trace, null, 1));
console.error(`${trace.events.length} demands, ${trace.players} players, ${(trace.horizonS / 86400).toFixed(1)}d horizon -> ${process.argv[2]}`);
