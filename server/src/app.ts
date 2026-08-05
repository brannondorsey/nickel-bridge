import { destroySharedDdPool } from '@bridge/ai';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { FastifyInstance, FastifyReply } from 'fastify';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recentActivity } from './activity.js';
import { enqueueAiField, noteInteractiveRequest, noteTournamentActivity } from './ai-players.js';
import { buildCompare, compareMin } from './compare.js';
import { hasSession, optionalUser, registerAuthRoutes, requireUserWithHandle } from './auth.js';
import { COOKIES_SECURE, PUBLIC_ORIGIN } from './config.js';
import { BOARDS_PER_TOURNAMENT, db } from './db.js';
import { registerDemoRoutes } from './demo.js';
import { getBoardAnalysis } from './analyze.js';
import { boardView, ensureAdvanced, loadBoard, submitCall, submitPlay } from './game.js';
import { serializeRequestLog } from './logging.js';
import { securityHeaders } from './security.js';
import { robotsTxt } from './seo.js';
import { playerStats, profileKind } from './stats.js';
import {
  boardDifficulty,
  getTournament,
  leaderboardMovement,
  myBoardSummaries,
  myEloDelta,
  myTournaments,
  placeUser,
  provisionalMin,
  visibleStandings,
} from './tournaments.js';

/**
 * How far back GET /api/activity reaches. One day wider than the seven the
 * feed renders, so the oldest local day the client keeps is never a partial
 * one — see the route's doc comment.
 */
const ACTIVITY_WINDOW_S = 8 * 86400;

/**
 * The board a URL names, or null if it doesn't name one.
 *
 * `Number.isInteger` is the load-bearing half, and it is easy to leave out
 * because the range check reads like it covers everything. It doesn't: `2.5` is
 * between 1 and 4, and the board it reaches is malformed all the way down —
 * boardConditions() derives `dealer = 0.5` and an undefined vulnerability from
 * it. The GET route creates a row before any of that is computed, so a fraction
 * used to persist junk under UNIQUE(tournament_id, user_id, board_no) — a
 * distinct row per distinct fraction, sailing past the four-board cap — and
 * then 500 on the malformed deal. SQLite stores it as a REAL, because `INTEGER`
 * is an affinity rather than a constraint on a non-STRICT table (see the
 * boards DDL in db.ts, which now refuses the storage class too).
 *
 * The sibling routes (/api/users/:id/stats, /api/compare/:id) already screen
 * their ids this way; this is the same discipline, in the one place all three
 * board routes can share it.
 */
function boardNoParam(raw: string): number | null {
  const no = Number(raw);
  return Number.isInteger(no) && no >= 1 && no <= BOARDS_PER_TOURNAMENT ? no : null;
}

/** Build the fully-wired Fastify app (no listen — tests use app.inject()). */
export async function buildApp(): Promise<FastifyInstance> {
  // serializeRequestLog adds the caller's identity (Fly-Client-IP + user agent) to
  // Fastify's default request line — see logging.ts for why that is worth the bytes.
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      serializers: { req: serializeRequestLog },
    },
  });

  await app.register(fastifyCookie);

  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = process.env.WEB_DIST ?? join(here, '../../web/dist');

  // Browser-enforced hardening on every response — anti-framing, nosniff,
  // referrer policy, permissions policy, HSTS on https deployments, and a
  // deliberately narrow CSP that carries no resource allowlist. What each header
  // is for, and why the CSP stops where it does, is written down in security.ts
  // rather than here.
  //
  // Registered before any route so it covers all of them: the API, /auth, the
  // prerendered pages, the SPA shell, the 404 handler and the error handler
  // alike. A header set per-route is a header the next route forgets.
  const headers = securityHeaders({ hsts: COOKIES_SECURE });
  app.addHook('onSend', (_req, reply, payload, done) => {
    for (const [name, value] of Object.entries(headers)) reply.header(name, value);
    done(null, payload);
  });

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
  //
  // hasSession() is the interactivity test, not the /api/ prefix alone: the
  // leaderboard and player-stats reads are public now, so a scraper, an
  // uptime check or a hot-linked widget could otherwise hold the personas
  // parked forever without a single human at the keyboard.
  app.addHook('onRequest', (req, _reply, done) => {
    if (req.url.startsWith('/api/') && !req.url.startsWith('/api/demo') && hasSession(req)) noteInteractiveRequest();
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
    const boardNo = boardNoParam(no);
    if (!t || boardNo === null) return reply.code(404).send({ error: 'not found' });
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

  // Analyze — verdicts for a FINISHED board's review screen, computed on
  // first open and cached (board_analyses). `?par=1` adds stage 4 (par + the
  // counterfactual auctions) — the crossing/auction lenses request it, the
  // play lens deliberately doesn't, so its open never pays for
  // CalcDDTablePBN. Only offered on a board already 'done', whose hidden
  // hands boardView has therefore already revealed to this player; boards
  // are per-user rows, so there is no cross-player surface, and /api/* is in
  // the edge bypass set.
  //
  // Still in beta (see the beta_features migration in db.ts): gated here as
  // well as by the web client hiding its doors, since a client-side gate
  // alone is only a UI courtesy — this route is the one place that can
  // actually keep the feature (and the DDS work it costs) off an account
  // that hasn't opted in.
  app.get('/api/tournaments/:id/boards/:no/analysis', async (req, reply) => {
    const user = requireUserWithHandle(req, reply);
    if (!user) return;
    if (!user.beta_features) return reply.code(403).send({ error: 'beta feature not enabled' });
    const { id, no } = req.params as { id: string; no: string };
    const wantPar = (req.query as { par?: string }).par === '1';
    const t = getTournament(Number(id));
    const boardNo = Number(no);
    if (!t || !Number.isInteger(boardNo) || boardNo < 1 || boardNo > 4) {
      return reply.code(404).send({ error: 'not found' });
    }
    const b = loadBoard(t, user.id, boardNo, false);
    if (!b || b.row.state !== 'done') return reply.code(404).send({ error: 'not analyzable' });
    if (t.ai_field) noteTournamentActivity(t.id);
    return reply.send(await getBoardAnalysis(t, b, wantPar));
  });

  app.post('/api/tournaments/:id/boards/:no/call', async (req, reply) => {
    const user = requireUserWithHandle(req, reply);
    if (!user) return;
    const { id, no } = req.params as { id: string; no: string };
    const { call } = (req.body ?? {}) as { call?: number };
    const t = getTournament(Number(id));
    const boardNo = boardNoParam(no);
    if (!t || boardNo === null) return reply.code(404).send({ error: 'not found' });
    const b = loadBoard(t, user.id, boardNo, false);
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
    const boardNo = boardNoParam(no);
    if (!t || boardNo === null) return reply.code(404).send({ error: 'not found' });
    const b = loadBoard(t, user.id, boardNo, false);
    if (!b) return reply.code(404).send({ error: 'board not started' });
    if (typeof card !== 'number' || card < 0 || card > 51) return reply.code(400).send({ error: 'bad card' });
    if (t.ai_field) noteTournamentActivity(t.id);
    await submitPlay(b, card);
    return reply.send({ board: boardView(t, b, user.elo) });
  });

  // Public (see App.tsx's isPublicPath): the ladder is the same for everyone,
  // and it's the social proof a visitor who hasn't signed up yet should be
  // able to see. Two things consult the caller: `yourRatedTournaments`, and
  // whether the rows are filtered — an anonymous caller doesn't see players
  // who turned "Name on the ladder" off (users.ladder_listed, see auth.ts).
  // The omission is silent by design: ranks are rendered from position in
  // this array (Leaderboard.tsx), so a hidden player leaves no gap to notice,
  // and a signed-out visitor's #3 can differ from a signed-in one's. The
  // alternative — holding the numbering and leaving a hole — would advertise
  // that somebody is hiding, which is the thing the setting exists to avoid.
  app.get('/api/leaderboard', (req, reply) => {
    const user = optionalUser(req);
    const quota = provisionalMin();
    const rows = db
      .prepare(
        `SELECT id, handle, picture, elo, rated_tournaments, played_tournaments FROM (
           SELECT u.id, u.handle, u.picture, u.elo,
                  (SELECT COUNT(*) FROM elo_history h WHERE h.user_id = u.id) AS rated_tournaments,
                  (SELECT COUNT(DISTINCT b.tournament_id) FROM boards b
                    JOIN tournaments t ON t.id = b.tournament_id AND t.kind = 'standard'
                    WHERE b.user_id = u.id) AS played_tournaments
           FROM users u
            WHERE u.handle IS NOT NULL AND u.kind = 'human' AND (? = 1 OR u.ladder_listed = 1)
         ) WHERE rated_tournaments >= ? ORDER BY elo DESC, handle`,
      )
      .all(user ? 1 : 0, quota) as { id: number }[];
    const movement = leaderboardMovement();
    // null, not 0, when nobody is signed in: the client renders a "you'll join
    // the field once you've completed N crossings — x of N so far" note off
    // this number, and 0 would state that about a visitor who has no record to
    // be provisional about.
    const yourRatedTournaments = user
      ? (db.prepare(`SELECT COUNT(*) AS n FROM elo_history WHERE user_id = ?`).get(user.id) as { n: number }).n
      : null;
    // The house, alongside the ladder rather than on it. The personas never
    // rate (see ai-players.ts), so they have nothing to sort by and can't be
    // ranked — but "how do I stack up against The Shark" is the question the
    // ladder makes people ask, and their profiles are the only ones a visitor
    // without an account can open. This is where those get found.
    const house = db
      .prepare(`SELECT id, handle, picture FROM users WHERE kind = 'ai' AND handle IS NOT NULL ORDER BY id`)
      .all() as { id: number; handle: string; picture: string | null }[];
    return reply.send({
      leaderboard: rows.map((r) => ({ ...r, movement: movement.get(r.id) ?? null })),
      house,
      provisionalMin: quota,
      yourRatedTournaments,
    });
  });

  /**
   * The activity feed ("TRAFFIC"). Gated, unlike the ladder next to it: the
   * ladder is a bounded list of handles and ratings, while this is when real
   * people sit down to play and for how long. That is a behavioural record,
   * and it stays behind the toll gate.
   *
   * Eight days, not the seven the UI shows. The client groups by ITS OWN local
   * calendar day (the server has no timezone for anyone — see activity.ts), so
   * a day of slack guarantees the oldest rendered day is a whole one rather
   * than a stub clipped by the viewer's UTC offset.
   */
  app.get('/api/activity', (req, reply) => {
    if (!requireUserWithHandle(req, reply)) return;
    return reply.send(recentActivity(Math.floor(Date.now() / 1000) - ACTIVITY_WINDOW_S, provisionalMin()));
  });

  /**
   * Public for the house, gated for everyone else.
   *
   * The benchmark personas' profiles are calibration content — synthetic
   * players, no person behind them — so a visitor can read one without an
   * account and see what a real record looks like. A human's profile is a
   * different thing: handle, avatar, account age, a day-by-day activity
   * heatmap, rivalries, every tournament they've played. Served anonymously,
   * that turns a sequential id walk into a roster dump, and this app has no
   * rate limiting to slow one down.
   *
   * The 401 is deliberately uniform — an unknown id answers the same as a real
   * person's — so an anonymous walk can't even map which accounts exist. A
   * signed-in caller still gets the honest 404, and the whole
   * requireUserWithHandle behaviour it had before this route went public.
   */
  app.get('/api/users/:id/stats', (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const kind = Number.isInteger(id) ? profileKind(id) : null;
    if (kind !== 'ai' && !requireUserWithHandle(req, reply)) return;
    const stats = kind ? playerStats(id) : null;
    if (!stats) return reply.code(404).send({ error: 'not found' });
    return reply.send(stats);
  });

  /**
   * Compare — the caller's record beside another player's.
   *
   * Always gated, with no house exemption like the stats route above: this is
   * scoped to the VIEWER, so there is no version of it that means anything
   * without a session. That is also why it lives at /api/compare/:id rather
   * than under /api/users/:id — and why the web route is /compare/:id and not
   * /players/:id/compare, which `isPublicPath` would have swept into the public
   * prefix by `startsWith` (see server/src/seo.ts).
   *
   * Comparing yourself to yourself is a degenerate page — every margin zero —
   * so it is refused rather than rendered. The entry points never offer it.
   */
  app.get('/api/compare/:id', (req, reply) => {
    const me = requireUserWithHandle(req, reply);
    if (!me) return;
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(404).send({ error: 'not found' });
    if (id === me.id) return reply.code(400).send({ error: 'cannot compare with yourself' });
    const view = buildCompare(me.id, id, { provisionalMin: provisionalMin(), minBoards: compareMin() });
    if (!view) return reply.code(404).send({ error: 'not found' });
    return reply.send(view);
  });

  // ---- discoverability ----
  //
  // Throwaway origins must never compete with production in the search index.
  // The demo app and every PR preview serve a byte-identical build from their
  // own hostnames (*.fly.dev, demo-bridge.brannon.online), so without this the
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

  // The Disallow list is not written here: it is derived from SITE_ROUTES in
  // seo.ts, the one table that also builds the sitemap (via
  // web/scripts/prerender.mjs) and is cross-checked against App.tsx's sign-in
  // gate. Three files that had to agree, with nothing checking that they did
  // — the reasoning for each route now lives beside it in that table.
  app.get('/robots.txt', (_req, reply) =>
    reply
      .type('text/plain; charset=utf-8')
      .send(robotsTxt({ throwaway: throwawayOrigin, origin: PUBLIC_ORIGIN })),
  );

  // ---- static SPA ----
  if (existsSync(webDist)) {
    // Prerendered glossary pages (web/dist/glossary-static, built by
    // web/scripts/prerender.mjs) shadow the SPA fallback for the two public
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

    // index: false so `/` is ours to answer below. @fastify/static registers a
    // route for the prefix itself — not just prefix + '*' — so leaving the
    // default on and adding app.get('/') is FST_ERR_DUPLICATED_ROUTE at boot,
    // not a route-priority contest like /glossary wins against the wildcard.
    // Nothing else depended on directory-index resolution: both fallbacks
    // below name index.html explicitly.
    await app.register(fastifyStatic, { root: webDist, index: false });

    // The landing page, prerendered (web/dist/home-static/index.html) for the
    // crawlers that don't run JavaScript — the same deal the glossary gets,
    // for the one URL that matters most. Its own directory rather than a file
    // inside glossary-static/, because `prerendered` above is built by listing
    // that directory: a home.html in there would silently also answer to
    // /glossary/home.
    const staticHome = join(webDist, 'home-static', 'index.html');
    app.get('/', (_req, reply) =>
      existsSync(staticHome)
        ? reply.type('text/html; charset=utf-8').send(readFileSync(staticHome))
        : // dev (no prerender step has run) and the test fixtures: the SPA
          // shell is still a correct answer, just an empty one for crawlers.
          reply.sendFile('index.html'),
    );

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
