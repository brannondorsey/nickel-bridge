import type { FastifyInstance } from 'fastify';
import { aiPlayersEnabled, ensureAiPlayers } from './ai-players.js';
import { claimHandle, requireUserWithHandle, startSession, upsertGoogleUser } from './auth.js';
import { playThrough, seededErraticStrategy, tick } from './bot-play.js';
import { TournamentRow, UserRow, db } from './db.js';
import { ensureAdvanced, httpError, loadBoard, submitCall, submitPlay } from './game.js';
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

const stmtExhibitBySeed = db.prepare(`SELECT * FROM tournaments WHERE kind = 'exhibit' AND seed = ?`);
const stmtCreateExhibit = db.prepare(`INSERT INTO tournaments (name, seed, kind) VALUES (?, ?, 'exhibit') RETURNING *`);
const stmtDeleteBoard = db.prepare(`DELETE FROM boards WHERE tournament_id = ? AND user_id = ? AND board_no = ?`);

const DEMO_HANDLE = 'Inspector';
const NEW_CROSSER_HANDLE = 'New Crosser';
/** A seeded bot (see demo-seed.ts's DEFAULT_PROFILE) with a genuinely rich history — the "populated stats page" exhibit points here. */
const RICH_PROFILE_HANDLE = 'Margaret';

function demoEnabled(): boolean {
  return process.env.DEMO === '1';
}

/**
 * Claim `base` as the user's handle, falling back to numeric suffixes when a
 * tester got there first ("Inspector 2", …). Shared with the seeder's bots.
 */
export function claimHandleWithSuffix(user: UserRow, base: string): UserRow {
  for (let i = 0; i < 50 && !user.handle; i++) {
    user = claimHandle(user.id, i === 0 ? base : `${base} ${i + 1}`) ?? user;
  }
  return user;
}

/**
 * The shared demo identity. The `demo:` google_id prefix keeps it disjoint
 * from `dev:` (POST /auth/dev) users, so a tester dev-logging-in as
 * "inspector" can't collide with or hijack it. The handle is claimed lazily
 * because /api/* routes are gated on having one.
 */
export function ensureDemoUser(): UserRow {
  return claimHandleWithSuffix(upsertGoogleUser('demo:inspector', null, DEMO_HANDLE, null), DEMO_HANDLE);
}

/**
 * A permanently empty persona: zero boards, forever. It exists purely so a
 * tester can reach Player.tsx's cold-start empty state without hunting for a
 * real teammate who hasn't played, and so the handle-collision exhibit
 * always has a guaranteed-taken name to prefill — both need it to exist
 * synchronously, so it's ensured here (called from /api/demo/scenarios),
 * not only in the background seeder.
 */
export function ensureNewCrosser(): UserRow {
  return claimHandleWithSuffix(upsertGoogleUser('demo:new-crosser', null, NEW_CROSSER_HANDLE, null), NEW_CROSSER_HANDLE);
}

/**
 * Exhibit tournaments hold scenario boards, identified by (kind='exhibit',
 * seed) — the seed must stay the literal string the recipe was mined against
 * (deals derive from it). The kind column also keeps them out of placement,
 * the lobby, the Elo replay, and stats (see db.ts and tournaments.ts).
 */
export function ensureExhibitTournament(seed: string): TournamentRow {
  const existing = stmtExhibitBySeed.get(seed) as TournamentRow | undefined;
  return existing ?? (stmtCreateExhibit.get(exhibitName(seed), seed) as TournamentRow);
}

/**
 * Serialize scenario runs per user: every visitor shares the Inspector, and
 * a replay spans many awaits (DDS solves), so two concurrent clicks on
 * exhibits sharing a (seed, boardNo) would otherwise interleave
 * delete-then-replay on the same board row — the loser's save() would then
 * silently update a deleted row id. Chaining per user makes the second click
 * wait for (and then reset) the first.
 */
const scenarioRuns = new Map<number, Promise<unknown>>();

export function runScenario(userId: number, s: Scenario): Promise<{ tournamentId: number; boardNo: number }> {
  const prev = scenarioRuns.get(userId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => runScenarioNow(userId, s));
  scenarioRuns.set(userId, run);
  return run;
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
async function runScenarioNow(userId: number, s: Scenario): Promise<{ tournamentId: number; boardNo: number }> {
  const t = ensureExhibitTournament(s.seed);
  if (s.completesTournament) {
    // The "TOURNAMENT SUMMARY →" reveal only shows a real result if the
    // other boards are actually complete — bot-play the acting user through
    // them with the same deterministic strategy the ambient seeder uses for
    // real players (see bot-play.ts).
    await playThrough(t, userId, s.boardNo - 1, (no) => seededErraticStrategy(`exhibit-prior:${s.seed}:${no}`));
  }
  stmtDeleteBoard.run(t.id, userId, s.boardNo);
  const b = loadBoard(t, userId, s.boardNo, true)!;
  await ensureAdvanced(b);
  for (const a of s.actions) {
    if (a.kind === 'call') await submitCall(b, a.value);
    else await submitPlay(b, a.value);
    await tick(); // let other requests interleave between synchronous DD solves
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

  app.get('/api/demo/scenarios', async (req, reply) => {
    if (!demoEnabled()) return reply.code(404).send({ error: 'not found' });
    if (!requireUserWithHandle(req, reply)) return;
    const newCrosser = ensureNewCrosser();
    // Dynamic import mirrors /api/demo/reset below — it avoids a
    // module-load-time circular import between demo.ts and demo-seed.ts.
    const { ensureBot } = await import('./demo-seed.js');
    const richProfile = ensureBot(RICH_PROFILE_HANDLE);
    return reply.send({
      scenarios: SCENARIOS.map(({ id, label, description, category }) => ({ id, label, description, category })),
      newCrosserId: newCrosser.id,
      richProfileId: richProfile.id,
      // Guaranteed taken (just claimed above, in this same request) — the
      // handle-collision exhibit prefills the picker with this so the live
      // 409 fires on the very first submit, with no dependency on the
      // ambient bot seeder having finished yet.
      collisionHandle: newCrosser.handle ?? NEW_CROSSER_HANDLE,
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
  // The wipe goes through the seeder's queue, so it waits out any in-flight
  // seed instead of yanking rows from under it. It kills every session
  // including the requester's — re-create the Inspector and hand back a
  // fresh cookie in the same response, then let the reseed refill ambient
  // data in the background exactly like boot. (A non-seed request already in
  // flight across the wipe can still lose its writes — save() is scoped to
  // exact row identity in game.ts, so that write drops instead of
  // corrupting reseeded rows.)
  app.post('/api/demo/reset', async (req, reply) => {
    if (!demoEnabled()) return reply.code(404).send({ error: 'not found' });
    if (!requireUserWithHandle(req, reply)) return;
    const { reseed = true } = (req.body ?? {}) as { reseed?: boolean };
    const seeder = await import('./demo-seed.js');
    await seeder.wipeDemoData();
    const user = ensureDemoUser();
    // The wipe deleted the benchmark AI personas along with everyone else —
    // re-create them now so tournaments played after the reset get their
    // house rows (queued play tasks re-ensure too, but placement can race
    // ahead of the reseed).
    if (aiPlayersEnabled()) ensureAiPlayers();
    startSession(reply, user.id);
    if (reseed) seeder.seedDemo(req.log).catch((err) => req.log.error(err, 'demo reseed failed'));
    return reply.send({ ok: true });
  });
}
