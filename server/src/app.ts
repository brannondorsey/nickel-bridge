import { destroySharedDdPool } from '@bridge/ai';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { FastifyInstance, FastifyReply } from 'fastify';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enqueueAiField, noteInteractiveRequest, noteTournamentActivity } from './ai-players.js';
import { registerAuthRoutes, requireUserWithHandle } from './auth.js';
import { db } from './db.js';
import { registerDemoRoutes } from './demo.js';
import { boardView, ensureAdvanced, loadBoard, submitCall, submitPlay } from './game.js';
import { playerStats } from './stats.js';
import {
  boardDifficulty,
  DEMO_PROVISIONAL_MIN_TOURNAMENTS,
  getTournament,
  leaderboardMovement,
  myBoardSummaries,
  myEloDelta,
  myTournaments,
  placeUser,
  PROVISIONAL_MIN_TOURNAMENTS,
  visibleStandings,
} from './tournaments.js';

/**
 * Origin this deployment answers on, for the absolute URL in robots.txt (the
 * Sitemap directive is required to be absolute). BASE_URL is already the app's
 * own notion of its public address — auth.ts builds the OAuth redirect from it
 * — so there's no second thing to configure.
 *
 * Validated rather than defaulted, because BASE_URL is not always ours: Vite
 * defines a BASE_URL of its own (the public base path, default "/") and Vitest
 * puts it on process.env, so under the test runner this reads "/". Anything
 * that isn't an absolute http(s) URL falls back to the dev origin.
 */
const PUBLIC_ORIGIN = /^https?:\/\//.test(process.env.BASE_URL ?? '')
  ? process.env.BASE_URL!.replace(/\/+$/, '')
  : 'http://localhost:3000';

/** Build the fully-wired Fastify app (no listen — tests use app.inject()). */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(fastifyCookie);

  // Tear down the sampled-play DDS worker pool (if one ever spawned) so the
  // process exits promptly on close; a no-op on expert-only instances.
  app.addHook('onClose', () => destroySharedDdPool());

  registerAuthRoutes(app);
  registerDemoRoutes(app); // no-op unless DEMO=1 (preview deployments only)

  // Liveness check for Fly's http_service health checks — no auth, no DB touch.
  app.get('/health', (req, reply) => reply.send({ ok: true }));

  // Every interactive API request parks the AI personas' non-urgent
  // background play for a quiet window (see ai-players.ts scheduling).
  // /api/demo is excluded so a demo reset isn't gated on its own request.
  app.addHook('onRequest', (req, _reply, done) => {
    if (req.url.startsWith('/api/') && !req.url.startsWith('/api/demo')) noteInteractiveRequest();
    done();
  });

  // ---- game & tournament API ----

  app.post('/api/play', (req, reply) => {
    const user = requireUserWithHandle(req, reply);
    if (!user) return;
    const { tournament, nextBoard } = placeUser(user.id, user.difficulty);
    // Fire-and-forget: a human is headed into this tournament, so mark it
    // interactively active (its lookahead boards become urgent) and make
    // sure the personas' play is queued. Idempotent — the scheduler
    // re-derives remaining work from the DB — so calling on every placement
    // (creation, join, resume) doubles as self-healing.
    if (tournament.ai_field) {
      noteTournamentActivity(tournament.id);
      enqueueAiField(tournament.id, req.log);
    }
    return reply.send({ tournamentId: tournament.id, boardNo: nextBoard });
  });

  app.get('/api/tournaments', (req, reply) => {
    const user = requireUserWithHandle(req, reply);
    if (!user) return;
    const mine = myTournaments(user.id).map((t) => ({
      id: t.id,
      name: t.name,
      difficulty: t.difficulty,
      myDone: t.myDone,
      createdAt: t.created_at,
      myLastPlayedAt: t.myLastPlayedAt,
      standings: visibleStandings(t.id),
    }));
    return reply.send({ tournaments: mine });
  });

  app.get('/api/tournaments/:id', (req, reply) => {
    const user = requireUserWithHandle(req, reply);
    if (!user) return;
    const t = getTournament(Number((req.params as { id: string }).id));
    if (!t) return reply.code(404).send({ error: 'not found' });
    const myBoards = myBoardSummaries(t.id, user.id);
    return reply.send({
      id: t.id,
      name: t.name,
      difficulty: t.difficulty,
      boardDifficulties: myBoards.map((b) => boardDifficulty(t, b.no)),
      createdAt: t.created_at,
      myDone: myBoards.filter((b) => b.state === 'done').length,
      myEloDelta: myEloDelta(t.id, user.id),
      myBoards,
      standings: visibleStandings(t.id),
    });
  });

  app.get('/api/tournaments/:id/boards/:no', async (req, reply) => {
    const user = requireUserWithHandle(req, reply);
    if (!user) return;
    const { id, no } = req.params as { id: string; no: string };
    const t = getTournament(Number(id));
    const boardNo = Number(no);
    if (!t || boardNo < 1 || boardNo > 4) return reply.code(404).send({ error: 'not found' });
    const b = loadBoard(t, user.id, boardNo, true);
    if (!b) return reply.code(404).send({ error: 'not found' });
    // A human is playing here: keep this tournament's lookahead window live,
    // and start persona play on demand (covers direct-URL resumes and demo
    // ambient tournaments, which are never played at boot).
    if (t.ai_field) {
      noteTournamentActivity(t.id);
      enqueueAiField(t.id, req.log);
    }
    await ensureAdvanced(b);
    return reply.send(boardView(t, b, user.elo));
  });

  app.post('/api/tournaments/:id/boards/:no/call', async (req, reply) => {
    const user = requireUserWithHandle(req, reply);
    if (!user) return;
    const { id, no } = req.params as { id: string; no: string };
    const { call } = (req.body ?? {}) as { call?: number };
    const t = getTournament(Number(id));
    if (!t) return reply.code(404).send({ error: 'not found' });
    const b = loadBoard(t, user.id, Number(no), false);
    if (!b) return reply.code(404).send({ error: 'board not started' });
    if (typeof call !== 'number' || call < 0 || call > 37) return reply.code(400).send({ error: 'bad call' });
    if (t.ai_field) noteTournamentActivity(t.id);
    const evaluation = await submitCall(b, call);
    return reply.send({ evaluation, board: boardView(t, b, user.elo) });
  });

  app.post('/api/tournaments/:id/boards/:no/play', async (req, reply) => {
    const user = requireUserWithHandle(req, reply);
    if (!user) return;
    const { id, no } = req.params as { id: string; no: string };
    const { card } = (req.body ?? {}) as { card?: number };
    const t = getTournament(Number(id));
    if (!t) return reply.code(404).send({ error: 'not found' });
    const b = loadBoard(t, user.id, Number(no), false);
    if (!b) return reply.code(404).send({ error: 'board not started' });
    if (typeof card !== 'number' || card < 0 || card > 51) return reply.code(400).send({ error: 'bad card' });
    if (t.ai_field) noteTournamentActivity(t.id);
    await submitPlay(b, card);
    return reply.send({ board: boardView(t, b, user.elo) });
  });

  app.get('/api/leaderboard', (req, reply) => {
    const user = requireUserWithHandle(req, reply);
    if (!user) return;
    // DEMO=1 (previews + the permanent demo app) relaxes the quota so the
    // boot seeder's ambient tournaments — at most 2 per bot, see
    // DEMO_PROVISIONAL_MIN_TOURNAMENTS's doc comment — still populate a
    // visible leaderboard; off (the production quota applies) everywhere else.
    const provisionalMin = process.env.DEMO === '1' ? DEMO_PROVISIONAL_MIN_TOURNAMENTS : PROVISIONAL_MIN_TOURNAMENTS;
    const rows = db
      .prepare(
        `SELECT id, handle, picture, elo, rated_tournaments, played_tournaments FROM (
           SELECT u.id, u.handle, u.picture, u.elo,
                  (SELECT COUNT(*) FROM elo_history h WHERE h.user_id = u.id) AS rated_tournaments,
                  (SELECT COUNT(DISTINCT b.tournament_id) FROM boards b
                    JOIN tournaments t ON t.id = b.tournament_id AND t.kind = 'standard'
                    WHERE b.user_id = u.id) AS played_tournaments
           FROM users u WHERE u.handle IS NOT NULL AND u.kind = 'human'
         ) WHERE rated_tournaments >= ? ORDER BY elo DESC, handle`,
      )
      .all(provisionalMin) as { id: number }[];
    const movement = leaderboardMovement();
    const yourRatedTournaments = (
      db.prepare(`SELECT COUNT(*) AS n FROM elo_history WHERE user_id = ?`).get(user.id) as { n: number }
    ).n;
    return reply.send({
      leaderboard: rows.map((r) => ({ ...r, movement: movement.get(r.id) ?? null })),
      provisionalMin,
      yourRatedTournaments,
    });
  });

  app.get('/api/users/:id/stats', (req, reply) => {
    const user = requireUserWithHandle(req, reply);
    if (!user) return;
    const id = Number((req.params as { id: string }).id);
    const stats = Number.isInteger(id) ? playerStats(id) : null;
    if (!stats) return reply.code(404).send({ error: 'not found' });
    return reply.send(stats);
  });

  // ---- discoverability ----
  //
  // Throwaway origins must never compete with production in the search index.
  // The demo app and every PR preview serve a byte-identical build from their
  // own hostnames (*.fly.dev, demo.bridge.brannon.online), so without this the
  // index fills with duplicates of the real site — outranking it, and handing
  // searchers a database that gets wiped on a schedule. Both flags are the
  // reliable tell: invariant 5 forbids either on the production app.
  const throwawayOrigin = process.env.DEMO === '1' || process.env.DEV_AUTH === '1';
  if (throwawayOrigin) {
    // Belt and braces with the robots.txt below: robots.txt asks a crawler not
    // to fetch, X-Robots-Tag tells one that fetched anyway not to index. The
    // second matters more here, since a URL can be indexed from inbound links
    // alone — exactly what a PR preview link in a pull request is.
    app.addHook('onSend', (_req, reply, payload, done) => {
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      done(null, payload);
    });
  }

  app.get('/robots.txt', (_req, reply) => {
    const body = throwawayOrigin
      ? 'User-agent: *\nDisallow: /\n'
      : [
          'User-agent: *',
          'Allow: /',
          // Everything below needs an account, so it renders as the same login
          // splash for a crawler. Nothing to index, and it burns crawl budget
          // that should go to the glossary.
          'Disallow: /api/',
          'Disallow: /auth/',
          'Disallow: /t/',
          'Disallow: /players/',
          'Disallow: /scenarios',
          'Disallow: /tour',
          '',
          `Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`,
          '',
        ].join('\n');
    return reply.type('text/plain; charset=utf-8').send(body);
  });

  // ---- static SPA ----
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = process.env.WEB_DIST ?? join(here, '../../web/dist');
  if (existsSync(webDist)) {
    // Prerendered glossary pages (web/dist/glossary-static, built by
    // web/scripts/prerender-glossary.mjs) shadow the SPA fallback for the two public
    // glossary routes. They are the same shell with the term's content already
    // in the HTML, so a crawler that doesn't run JavaScript gets the actual
    // definition instead of an empty #root — and a human still boots the normal
    // app, because the module script tag is copied through untouched.
    const staticGlossary = join(webDist, 'glossary-static');
    const prerendered = existsSync(staticGlossary)
      ? new Set(
          readdirSync(staticGlossary)
            .filter((f) => f.endsWith('.html'))
            .map((f) => f.slice(0, -'.html'.length)),
        )
      : new Set<string>();

    /**
     * Serve a prerendered page, falling back to the SPA shell when there isn't
     * one. Membership in `prerendered` is what makes the name safe to join onto
     * a path — it can only ever be a filename this build emitted.
     *
     * `missing` is the status for that fallback, and it differs by call site:
     * a URL that *could* have named a term but doesn't is a dead end and should
     * say so (404), while /glossary itself is a real page whatever its query
     * string. Serving the shell with a 404 is deliberate, not a contradiction —
     * browsers render a 404 body normally, so the SPA still boots and shows its
     * own "not in the ledger" sheet, while crawlers get the honest signal
     * instead of another 200 that looks like content.
     */
    const sendPrerendered = (name: string, reply: FastifyReply, missing: 200 | 404 = 200) =>
      prerendered.has(name)
        ? reply.type('text/html; charset=utf-8').send(readFileSync(join(staticGlossary, `${name}.html`)))
        : reply.code(missing).sendFile('index.html');

    await app.register(fastifyStatic, { root: webDist });

    // ?term=<slug> is the glossary's live sheet mechanism (see
    // GlossaryContext), and the URL the app leaves a reader on — so it's the
    // form that actually gets shared. Serving the matching term page here keeps
    // the server's answer the same as the client's, which also means a shared
    // link unfurls as that term rather than as the whole ledger, and its
    // self-canonical hands the link back to /glossary/<slug>. An unrecognised
    // term is not an error: /glossary is still /glossary.
    app.get('/glossary', (req, reply) => {
      const { term } = req.query as { term?: string };
      // Resolve to a page BEFORE dispatching: an unknown term has to land on
      // the prerendered ledger index, not on sendPrerendered's bare-shell
      // fallback, or a junk query would strip the page of its own content.
      const named = term && term !== 'index' && prerendered.has(term);
      return sendPrerendered(named ? term : 'index', reply);
    });

    app.get('/glossary/:slug', (req, reply) => {
      const { slug } = req.params as { slug: string };
      // 'index' is the ledger page's own file, not a term — don't let
      // /glossary/index become a second URL for /glossary.
      return sendPrerendered(slug === 'index' ? '' : slug, reply, 404);
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/auth')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    reply.code(status).send({ error: err.message });
  });

  return app;
}
