import type { FastifyInstance } from 'fastify';
import { requireUserWithHandle, startSession, upsertGoogleUser } from './auth.js';
import { TournamentRow, UserRow, db } from './db.js';
import { ensureAdvanced, httpError, loadBoard, submitCall, submitPlay } from './game.js';
import { validateHandle } from './handle.js';
import { Scenario, SCENARIOS, exhibitName, scenarioById } from './scenarios.js';

/**
 * Demo mode (DEMO=1) — preview-deployment conveniences for click-testing.
 * Everything here is registered only when DEMO=1 and re-checked per request,
 * and must NEVER be enabled in production (see CLAUDE.md invariant 5): the
 * front door below hands out an authenticated session to anyone who asks.
 *
 * GET /demo is the frictionless entry point linked from PR preview comments:
 * it signs the visitor in as the shared "Inspector" persona (no login form,
 * no handle prompt) and drops them on the /scenarios gallery, from which they
 * can jump into prepared game states.
 */

const stmtSetHandle = db.prepare(`UPDATE users SET handle = ?, handle_key = ? WHERE id = ?`);
const stmtHandleTaken = db.prepare(`SELECT 1 FROM users WHERE handle_key = ? AND id != ?`);
const stmtUser = db.prepare(`SELECT * FROM users WHERE id = ?`);
const stmtTournamentByName = db.prepare(`SELECT * FROM tournaments WHERE name = ?`);
const stmtCreateExhibit = db.prepare(`INSERT INTO tournaments (name, seed) VALUES (?, ?) RETURNING *`);
const stmtDeleteBoard = db.prepare(`DELETE FROM boards WHERE tournament_id = ? AND user_id = ? AND board_no = ?`);

export const DEMO_HANDLE = 'Inspector';

export function demoEnabled(): boolean {
  return process.env.DEMO === '1';
}

/**
 * The shared demo identity. The `demo:` google_id prefix keeps it disjoint
 * from `dev:` (POST /auth/dev) users, so a tester dev-logging-in as
 * "inspector" can't collide with or hijack it. The handle is claimed lazily
 * (with a numeric-suffix fallback in the unlikely case a tester took
 * "Inspector" first) because /api/* routes are gated on having one.
 */
export function ensureDemoUser(): UserRow {
  let user = upsertGoogleUser('demo:inspector', null, DEMO_HANDLE, null);
  if (!user.handle) {
    for (let i = 0; i < 50 && !user.handle; i++) {
      const v = validateHandle(i === 0 ? DEMO_HANDLE : `${DEMO_HANDLE} ${i + 1}`);
      if (!v.ok || stmtHandleTaken.get(v.key, user.id)) continue;
      stmtSetHandle.run(v.handle, v.key, user.id);
      user = stmtUser.get(user.id) as UserRow;
    }
  }
  return user;
}

/**
 * Exhibit tournaments hold scenario boards. They are looked up by their
 * `Exhibit: <seed>` name — which also keeps them out of JIT placement (see
 * the name filter in tournaments.ts) — because the seed must stay the
 * literal string the recipe was mined against (deals derive from it).
 */
export function ensureExhibitTournament(seed: string): TournamentRow {
  const name = exhibitName(seed);
  const existing = stmtTournamentByName.get(name) as TournamentRow | undefined;
  return existing ?? (stmtCreateExhibit.get(name, seed) as TournamentRow);
}

/**
 * Materialize a scenario for one user: wipe their board row (re-clicking an
 * exhibit always resets it — also how two scenarios sharing a (seed, board)
 * coexist) and replay the recipe's human actions through the real engine.
 * Robots advance inside each submit, exactly as in live play. The `expect`
 * check is the drift guard: if a deliberate robot change altered what these
 * actions produce, fail loudly rather than dropping the tester mid-nowhere
 * (server/test/scenarios.test.ts catches this before it ever deploys).
 */
export async function runScenario(userId: number, s: Scenario): Promise<{ tournamentId: number; boardNo: number }> {
  const t = ensureExhibitTournament(s.seed);
  stmtDeleteBoard.run(t.id, userId, s.boardNo);
  const b = loadBoard(t, userId, s.boardNo, true)!;
  await ensureAdvanced(b);
  for (const a of s.actions) {
    if (a.kind === 'call') await submitCall(b, a.value);
    else await submitPlay(b, a.value);
  }
  if (b.row.state !== s.expect) {
    throw httpError(500, `scenario ${s.id} drifted: expected ${s.expect}, got ${b.row.state}`);
  }
  return { tournamentId: t.id, boardNo: s.boardNo };
}

export function registerDemoRoutes(app: FastifyInstance): void {
  if (!demoEnabled()) return;

  // The per-handler demoEnabled() re-checks are belt-and-braces: routes are
  // only registered under DEMO=1 today, but a future refactor that hoists
  // registration must not silently open these up.
  app.get('/demo', (req, reply) => {
    if (!demoEnabled()) return reply.code(404).send({ error: 'not found' });
    const user = ensureDemoUser();
    startSession(reply, user.id);
    return reply.redirect('/scenarios');
  });

  app.get('/api/demo/scenarios', (req, reply) => {
    if (!demoEnabled()) return reply.code(404).send({ error: 'not found' });
    if (!requireUserWithHandle(req, reply)) return;
    return reply.send({
      scenarios: SCENARIOS.map(({ id, label, description, category }) => ({ id, label, description, category })),
    });
  });

  app.post('/api/demo/scenarios/:id', async (req, reply) => {
    if (!demoEnabled()) return reply.code(404).send({ error: 'not found' });
    const user = requireUserWithHandle(req, reply);
    if (!user) return;
    const s = scenarioById.get((req.params as { id: string }).id);
    if (!s) return reply.code(404).send({ error: 'unknown scenario' });
    return reply.send(await runScenario(user.id, s));
  });

  // Full wipe + reseed, for starting a click-testing round from a pristine
  // state (preview volumes persist across pushes, so debris accumulates).
  // The wipe kills every session including the requester's — re-create the
  // Inspector and hand back a fresh cookie in the same response, then let
  // the reseed refill ambient data in the background exactly like boot.
  app.post('/api/demo/reset', async (req, reply) => {
    if (!demoEnabled()) return reply.code(404).send({ error: 'not found' });
    if (!requireUserWithHandle(req, reply)) return;
    const { reseed = true } = (req.body ?? {}) as { reseed?: boolean };
    const seeder = await import('./demo-seed.js');
    seeder.wipeAllData();
    const user = ensureDemoUser();
    startSession(reply, user.id);
    if (reseed) seeder.seedDemo(req.log).catch((err) => req.log.error(err, 'demo reseed failed'));
    return reply.send({ ok: true });
  });
}
