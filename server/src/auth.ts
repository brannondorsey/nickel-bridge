import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DIFFICULTIES, type SettableDifficulty } from '@bridge/ai';
import { COOKIES_SECURE, PUBLIC_ORIGIN, isCanonicalHost } from './config.js';
import { db, UserRow } from './db.js';
import { compareMin } from './compare.js';
import { validateHandle } from './handle.js';
import { completedBoardCount } from './stats.js';
import { medalProgressFor } from './medals.js';
import { eloDrift, lastCrossingSwing, provisionalMin, ratedTournamentCount } from './tournaments.js';

/**
 * Google OAuth (authorization-code flow) with open signup, plus cookie
 * sessions stored in SQLite. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
 * BASE_URL. For local development without Google credentials set
 * DEV_AUTH=1 to enable name-only login at POST /auth/dev.
 */
const SESSION_COOKIE = 'session';
const SESSION_TTL_S = 90 * 24 * 3600;

/**
 * The OAuth CSRF state, and the three things about it that were wrong.
 *
 * The cookie holds a LIST of recently-issued states rather than one, joined
 * by '.' (which base64url never produces, so the delimiter can't collide with
 * a value). A single slot meant the second start of a sign-in silently voided
 * the first, and a browser starts twice more often than it looks: two tabs,
 * back-then-retry from Google's account chooser, or an impatient second tap
 * while a suspended Fly machine wakes. Whichever leg the visitor actually
 * finished, the cookie had already been overwritten by the other, and they
 * got a hard error for doing nothing wrong. Keeping the last few lets any
 * in-flight attempt land; it costs ~68 bytes and gives an attacker nothing,
 * since every value still has to be one this browser was handed.
 *
 * The window was ten minutes, which is not long enough for the sign-in this
 * app actually asks for. A first-time visitor meets Google's account chooser,
 * a password manager and very often a second factor on another device; the
 * players who reported this are not people who breeze through that. Thirty
 * minutes is still comfortably inside the range a one-shot CSRF token wants
 * to live, and the cookie's Max-Age is refreshed on each start.
 *
 * And it is Secure on an https deployment, which it should always have been —
 * the session cookie beside it already was. Safe now for the same reason that
 * one is: the edge answers plain http with a 301 to https, so no visitor is
 * on an origin that would drop it.
 */
const OAUTH_STATE_COOKIE = 'oauth_state';
const OAUTH_STATE_TTL_S = 30 * 60;
const OAUTH_STATE_MAX = 3;

const stmtSessionUser = db.prepare(
  `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > unixepoch()`,
);
const stmtInsertSession = db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, unixepoch() + ?)`);
const stmtDeleteSession = db.prepare(`DELETE FROM sessions WHERE id = ?`);
const stmtUserByGoogleId = db.prepare(`SELECT * FROM users WHERE google_id = ?`);
const stmtInsertUser = db.prepare(
  `INSERT INTO users (google_id, email, name, picture) VALUES (?, ?, ?, ?) RETURNING *`,
);
const stmtTouchUser = db.prepare(`UPDATE users SET email = ?, name = ?, picture = ? WHERE google_id = ?`);
const stmtSetHandle = db.prepare(`UPDATE users SET handle = ?, handle_key = ? WHERE id = ?`);
const stmtSetDifficulty = db.prepare(`UPDATE users SET difficulty = ? WHERE id = ?`);
const stmtSetOnboarded = db.prepare(`UPDATE users SET onboarded_at = unixepoch() WHERE id = ? AND onboarded_at IS NULL`);
const stmtSetLadderListed = db.prepare(`UPDATE users SET ladder_listed = ? WHERE id = ?`);
const stmtSetAutoClaim = db.prepare(`UPDATE users SET auto_claim = ? WHERE id = ?`);
const stmtSetBidFeedback = db.prepare(`UPDATE users SET bid_feedback = ? WHERE id = ?`);
const stmtSetBetaFeatures = db.prepare(`UPDATE users SET beta_features = ? WHERE id = ?`);
const stmtSetDoubleTapBid = db.prepare(`UPDATE users SET double_tap_bid = ? WHERE id = ?`);
const stmtSetTrickClearMode = db.prepare(`UPDATE users SET trick_clear_mode = ? WHERE id = ?`);
const stmtSetTrumpPlacement = db.prepare(`UPDATE users SET trump_placement = ? WHERE id = ?`);
const stmtSetFoilTrumps = db.prepare(`UPDATE users SET foil_trumps = ? WHERE id = ?`);
const stmtHandleTaken = db.prepare(`SELECT 1 FROM users WHERE handle_key = ? AND id != ?`);
const stmtUserById = db.prepare(`SELECT * FROM users WHERE id = ?`);

/**
 * The session's user, or null — without sending a 401.
 *
 * This is the read the public routes need: `/api/leaderboard` and
 * `/api/users/:id/stats` serve the same rows to everyone, and consult the
 * caller only to answer "…and where do *you* sit?" (see app.ts). Everything
 * that writes, or that reads a specific person's board state, goes through
 * requireUser/requireUserWithHandle below instead.
 */
export function optionalUser(req: FastifyRequest): UserRow | null {
  const sid = req.cookies[SESSION_COOKIE];
  if (!sid) return null;
  return (stmtSessionUser.get(sid) as UserRow | undefined) ?? null;
}

/**
 * Does this request come from a browser that has signed in at some point?
 *
 * Deliberately a cookie-presence check and not a session lookup: the only
 * caller is app.ts's interactive-request hook, which asks "is a person using
 * the app right now?" so the AI personas can get out of their way. A stale or
 * forged cookie answering yes costs one quiet window and nothing else, which
 * is a better trade than a DB round trip on every single API request.
 *
 * The reason this exists at all: some read-only API routes are public now, so
 * "an /api/ request arrived" no longer implies a human is at the keyboard —
 * an uptime check or a scraper polling the leaderboard would otherwise park
 * the personas' background play indefinitely.
 */
export function hasSession(req: FastifyRequest): boolean {
  return Boolean(req.cookies[SESSION_COOKIE]);
}

function requireUser(req: FastifyRequest, reply: FastifyReply): UserRow | null {
  const user = optionalUser(req);
  if (!user) {
    reply.code(401).send({ error: 'not signed in' });
    return null;
  }
  return user;
}

/**
 * Same as requireUser, but also enforces the first-login handle prompt: a
 * user who hasn't chosen a display handle yet cannot use the game/tournament
 * API, even if they bypass the frontend's onboarding gate.
 */
export function requireUserWithHandle(req: FastifyRequest, reply: FastifyReply): UserRow | null {
  const user = requireUser(req, reply);
  if (!user) return null;
  if (!user.handle) {
    reply.code(403).send({ error: 'handle required' });
    return null;
  }
  return user;
}

export function startSession(reply: FastifyReply, userId: number): void {
  const sid = randomBytes(32).toString('base64url');
  stmtInsertSession.run(sid, userId, SESSION_TTL_S);
  reply.setCookie(SESSION_COOKIE, sid, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIES_SECURE,
    maxAge: SESSION_TTL_S,
  });
}

/**
 * Claim `raw` as userId's display handle if it validates and is free; returns
 * the updated row, or null when invalid/taken. The one shared implementation
 * of the validate → uniqueness-check → set sequence — demo mode's Inspector
 * and seeded bots go through here too, so key derivation (case-folded, with
 * cross-script lookalikes folded onto their Latin twin — see handle.ts) can
 * never diverge between signup paths.
 */
export function claimHandle(userId: number, raw: string): UserRow | null {
  const result = validateHandle(raw);
  if (!result.ok || stmtHandleTaken.get(result.key, userId)) return null;
  stmtSetHandle.run(result.handle, result.key, userId);
  return stmtUserById.get(userId) as UserRow;
}

export function upsertGoogleUser(googleId: string, email: string | null, name: string, picture: string | null): UserRow {
  const existing = stmtUserByGoogleId.get(googleId) as UserRow | undefined;
  if (existing) {
    stmtTouchUser.run(email ?? existing.email, name || existing.name, picture ?? existing.picture, googleId);
    return stmtUserByGoogleId.get(googleId) as UserRow;
  }
  return stmtInsertUser.get(googleId, email, name, picture) as UserRow;
}

/** The states this browser currently has in flight, newest first. */
function readOauthStates(raw: string | undefined): string[] {
  return raw ? raw.split('.').filter(Boolean) : [];
}

/**
 * A sign-in that did not complete, handed back to the front door.
 *
 * This used to be `400 {"error":"bad oauth state"}` — a raw JSON body with no
 * markup, no styling and, crucially, no way back. Every reason a sign-in can
 * fail arrived as that same dead end, so a visitor who merely took too long
 * or tapped Cancel had no signal that trying again would work, and no link to
 * try it with. Several did the only thing left and emailed to say the site was
 * broken. Sending them to the landing page instead puts the toll gate and its
 * PLAY THE TOLL button back on screen with one line saying what happened, so
 * every transient cause costs one tap rather than the visit.
 *
 * The state cookie is deliberately NOT cleared here: a failure on one leg says
 * nothing about the others a browser may still have in flight, and clearing
 * would turn "one tab was stale" into "now none of them work". Unused states
 * expire on their own.
 */
function signInFailed(
  req: FastifyRequest,
  reply: FastifyReply,
  reason: 'cancelled' | 'expired' | 'failed',
): FastifyReply {
  /**
   * Already through the gate — say nothing and let them in.
   *
   * A browser with two tabs open finishes one, and the other arrives on a leg
   * that can no longer complete: a state nothing remembers, a cancelled
   * chooser, or a Google-side stumble on an attempt that was otherwise fine.
   * This person is signed in, so a notice telling them their sign-in failed
   * would be false, and alarming for being false.
   *
   * The check lives HERE rather than at the call sites because it started at
   * two of the four failure exits and was silently absent from the other two,
   * which made the guarantee written in CONTRIBUTING.md broader than the code
   * that backed it. One gate on the one function every failure leaves through
   * is a thing a later branch cannot forget to call.
   */
  if (optionalUser(req)) return reply.redirect('/');
  return reply.redirect(`/?signin=${reason}`);
}

export function registerAuthRoutes(app: FastifyInstance): void {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = `${PUBLIC_ORIGIN}/auth/google/callback`;

  app.get('/auth/google', (req, reply) => {
    if (!clientId) return reply.code(500).send({ error: 'GOOGLE_CLIENT_ID not configured' });
    /**
     * Start the flow on the canonical host, whatever host was asked.
     *
     * `redirectUri` is built from BASE_URL, so Google always returns the
     * visitor to the canonical origin — but the state cookie is set by
     * whichever host served THIS request, and a cookie is scoped to its host.
     * Reach production as `nickel-bridge.fly.dev` (an old link, a bookmark
     * from before the custom domain, anything a crawler surfaced — that origin
     * serves the whole app and its robots.txt says `Allow: /`) and the two
     * halves land on different hostnames: the cookie sits on fly.dev, the
     * callback arrives at bridge.brannon.online carrying nothing, and sign-in
     * fails every single time with no way for the visitor to work out why.
     *
     * One redirect before any state exists puts both halves on the same
     * origin, and the visitor ends up signed in on the canonical host, which
     * is where they wanted to be anyway.
     *
     * Scoped to this route rather than applied app-wide as a canonical-host
     * redirect, deliberately: `scripts/cloudflare.mjs --snapshot/--purge`
     * compares what the ORIGIN serves at `<app>.fly.dev` before and after a
     * deploy, and blanket-redirecting that hostname would have it diffing
     * redirects instead of content — the comparison would find every URL
     * identical and purge nothing, which is the exact failure mode that
     * script's doc comment warns about at length.
     */
    // isCanonicalHost (config.ts) owns the lowercasing and the "no BASE_URL
    // means nothing is non-canonical" case, so this route and app.ts's noindex
    // hook cannot drift apart about what counts as the canonical host.
    if (!isCanonicalHost(req.headers.host)) {
      return reply.redirect(`${PUBLIC_ORIGIN}/auth/google`);
    }
    const state = randomBytes(16).toString('base64url');
    const states = [state, ...readOauthStates(req.cookies[OAUTH_STATE_COOKIE])].slice(0, OAUTH_STATE_MAX);
    reply.setCookie(OAUTH_STATE_COOKIE, states.join('.'), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: COOKIES_SECURE,
      maxAge: OAUTH_STATE_TTL_S,
    });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  /**
   * Where Google sends the visitor back.
   *
   * Four unrelated things used to arrive here as one indistinguishable
   * `bad oauth state`: the cross-host cookie split above, a visitor who
   * cancelled at Google (`error=access_denied`, so no `code` — that single
   * `!code` was reading a deliberate choice as a protocol violation), a state
   * older than its window, and a state clobbered by a second start. They are
   * told apart now, logged apart, and none of them is a dead end.
   */
  app.get('/auth/google/callback', async (req, reply) => {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    const states = readOauthStates(req.cookies[OAUTH_STATE_COOKIE]);
    if (error) {
      // Not an error of ours: the visitor declined, or backed out of the
      // account chooser. Logged at info for that reason — and truncated,
      // because it is a query parameter anyone can set to any length.
      req.log.info({ oauthError: error.slice(0, 64) }, 'google sign-in did not complete');
      return signInFailed(req, reply, error === 'access_denied' ? 'cancelled' : 'failed');
    }
    if (!code || !state || !states.includes(state)) {
      // The state values themselves are never logged — they are this
      // browser's CSRF tokens, and the shape is what makes the cause
      // readable: no cookie at all reads as a cross-host or expired start,
      // a cookie that simply doesn't hold this state as a stale leg.
      req.log.warn(
        { hasCode: Boolean(code), hasState: Boolean(state), statesHeld: states.length, host: req.headers.host },
        'oauth callback did not match a state this browser started',
      );
      return signInFailed(req, reply, 'expired');
    }
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId!,
        client_secret: clientSecret!,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      req.log.error({ status: tokenRes.status }, 'google token exchange failed');
      return signInFailed(req, reply, 'failed');
    }
    const tokens = (await tokenRes.json()) as { access_token: string };
    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (!infoRes.ok) {
      req.log.error({ status: infoRes.status }, 'google userinfo failed');
      return signInFailed(req, reply, 'failed');
    }
    const info = (await infoRes.json()) as { sub: string; email?: string; name?: string; picture?: string };
    const user = upsertGoogleUser(info.sub, info.email ?? null, info.name ?? info.email ?? 'Player', info.picture ?? null);
    // Spent: this state must not authenticate a second callback, and the
    // cookie has no reason to sit in the browser for the rest of its window.
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
    startSession(reply, user.id);
    return reply.redirect('/');
  });

  // Local-development login (no Google round trip). Enabled only with DEV_AUTH=1.
  if (process.env.DEV_AUTH === '1') {
    app.post('/auth/dev', (req, reply) => {
      const { name } = (req.body ?? {}) as { name?: string };
      if (!name || !/^[\w .-]{1,40}$/.test(name)) return reply.code(400).send({ error: 'bad name' });
      const user = upsertGoogleUser(`dev:${name}`, null, name, null);
      startSession(reply, user.id);
      return reply.send({ ok: true });
    });
  }

  app.post('/auth/logout', (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) stmtDeleteSession.run(sid);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/api/me', (req, reply) => {
    const user = optionalUser(req);
    return reply.send({
      user: user
        ? {
            id: user.id,
            handle: user.handle,
            picture: user.picture,
            elo: user.elo,
            difficulty: user.difficulty,
            onboardedAt: user.onboarded_at,
            ladderListed: user.ladder_listed !== 0,
            autoClaim: user.auto_claim !== 0,
            bidFeedback: user.bid_feedback !== 0,
            betaFeatures: user.beta_features !== 0,
            doubleTapBid: user.double_tap_bid !== 0,
            trickClearMode: user.trick_clear_mode,
            trumpPlacement: user.trump_placement,
            foilTrumps: user.foil_trumps !== 0,
            // Completed standard boards. Here rather than derived on the client
            // because Compare's entry points need to know whether the VIEWER
            // has a record worth comparing, and on someone else's profile the
            // client has their board count but not its own. One cheap COUNT.
            boards: completedBoardCount(user.id),
            // Home's medal rail — fully computed server-side (tier, bar %,
            // tournaments remaining) so the client just renders it; null for
            // AI/house accounts (never applies to a real session, but keeps
            // medalProgressFor's human-only gate honest end to end).
            medals: medalProgressFor(user.id, user.kind),
            // Home's rating tile. `ratedTournaments` is the gate rather than
            // the figure: `elo` is ELO_INITIAL until a crossing actually rates
            // you, so before the first one Home keeps the plain greeting
            // instead of presenting 1200 as something that was earned.
            // `eloDrift` is the tile's delta — points moved since this player
            // last finished a crossing, which is entirely other people's play
            // (see eloDrift/stampCrossingBaseline in tournaments.ts, and the
            // elo_at_last_crossing migration in db.ts for why it needs a
            // stored baseline at all). Indexed reads, on the same route that
            // already pays for medals' two counts.
            ratedTournaments: ratedTournamentCount(user.id),
            eloDrift: eloDrift(user.id),
            // ...and the other half of that tile: what this player's last
            // crossing was worth, and when it ended. The tile leads with THAT
            // for an hour after a crossing ("▲12 in the last crossing") and
            // with the drift above once somebody else's play has actually
            // moved the rating ("▼7 since your last crossing"). null when that
            // crossing has not rated them yet — see lastCrossingSwing for why
            // naming an earlier one instead would be a wrong claim rather than
            // a stale one. The hour is decided on the client, off `finishedAt`,
            // for the reason the activity feed buckets its own days there: the
            // figure is read against the reader's own clock, and a boolean
            // computed here would already be stale by the time the page
            // rendered.
            lastCrossing: lastCrossingSwing(user.id),
          }
        : null,
      devAuth: process.env.DEV_AUTH === '1',
      googleAuth: Boolean(clientId),
      demo: process.env.DEMO === '1',
      // Compare's board floor, so the entry points and the server agree about
      // who gets a door. Sent rather than mirrored in the web bundle because
      // DEMO=1 relaxes it — a hardcoded copy would put the button on screens
      // the server then refuses, or hide it where the server would have said
      // yes. app.ts's compareMin() is the one place the env is read.
      compareMinBoards: compareMin(),
      // The leaderboard's rated-tournament quota (tournaments.ts's
      // provisionalMin()) — sent so the Home medal rail's club-tier copy can
      // say "...to join the rankings" only when this deployment's quota
      // actually matches the club medal's own 4-tournament threshold. DEMO=1
      // relaxes the quota to 1, so a hardcoded "4" in the copy would keep
      // claiming rankings aren't joined yet after they already were. See
      // MedalBar.tsx's doc comment.
      provisionalMin: provisionalMin(),
    });
  });

  // Robot-difficulty preference: future placements match tournaments of this
  // tier (already-started tournaments keep their stamped difficulty). Backend
  // only for now — no web UI sets this yet.
  app.post('/api/me/difficulty', (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { difficulty } = (req.body ?? {}) as { difficulty?: string };
    if (!DIFFICULTIES.includes(difficulty as SettableDifficulty)) {
      return reply.code(400).send({ error: 'bad difficulty' });
    }
    stmtSetDifficulty.run(difficulty, user.id);
    return reply.send({
      user: { id: user.id, handle: user.handle, picture: user.picture, elo: user.elo, difficulty },
    });
  });

  /**
   * The settings gate's account-backed preferences (web/src/pages/Settings.tsx).
   *
   * One partial-update endpoint rather than a route per switch: these are
   * plain per-user flags with no side effects, and the list will keep growing
   * (difficulty already exists as a backend-only preference and wants a UI).
   * Absent keys are left alone; a present key must be a boolean, so a typo'd
   * field can't silently no-op.
   *
   * - ladderListed — whether a visitor WITHOUT an account sees this player on
   *   /leaderboard. Deliberately narrow: it is not a general "make me
   *   private" flag, because there is nothing else to hide (profiles already
   *   refuse an anonymous caller for every human, the activity feed is
   *   gated), and it never applies to a signed-in caller — the field you are
   *   matchpointed against can always see who is in it.
   * - autoClaim — may the server fast-play a settled tail, or does the player
   *   play it out themselves? On the account and not in localStorage because
   *   it describes the person, not the browser. Only meaningful because the
   *   claim gate is pessimistic: opting out cannot change a score, since a
   *   claim now only fires on a position no legal card can change. It is
   *   ignored on 'optimistic' tournaments, where that guarantee does not
   *   hold — see the auto_claim migration in db.ts.
   * - bidFeedback — whether the post-call grading toast renders. Grading
   *   itself (bidEvals, stats, the post-board review table) is computed and
   *   stored unconditionally; this only gates the live interruption — see
   *   the bid_feedback migration in db.ts.
   * - betaFeatures — opt in to features still being tried out before a
   *   general release. Nothing is gated behind it today. Off by default in
   *   production, on by default on preview/demo deployments — see the
   *   beta_features migration in db.ts for why. This is the one row in
   *   Settings that GRANTS access rather than describing a preference, so it
   *   stays visible and settable the same way as the rest.
   * - doubleTapBid — whether a second tap on the already-selected call in the
   *   bid box submits it, without pressing the confirm CTA. Defaults false,
   *   unlike the three above: this is the one preference that changes
   *   existing accounts' behaviour on purpose, since accidental bids from the
   *   shortcut are exactly what shipping it off by default fixes — see the
   *   double_tap_bid migration in db.ts.
   * - trickClearMode — how a completed trick leaves the table: 'auto' (times
   *   out on its own, the shipped behaviour) or 'tap' (holds until the
   *   player taps the trick area).
   * - trumpPlacement — where the trump suit sits in a hand once a trump
   *   contract is settled: 'left' (the trump block moves to the front, the
   *   default) or 'suit' (always ♠♥♦♣, how every hand was laid out before
   *   this setting existed). Client-side ordering only — see the
   *   trump_placement migration in db.ts, and the one below it for why
   *   existing accounts were moved onto the new default rather than left
   *   holding the old one.
   * - foilTrumps — the holographic plate over the trump suit, in hand and on
   *   the table. Defaults false: unlike doubleTapBid (off because the shortcut
   *   was misfiring) or trumpPlacement (re-defaulted because players asked for
   *   it), there is simply no prior behaviour here to preserve, and a
   *   decorative treatment is not something to switch on for every account at
   *   once. Client-side only — see the foil_trumps migration in db.ts.
   *
   * The last two are TEXT enums rather than booleans (each names a MODE, not
   * a yes/no — see their migrations in db.ts), so they live in `enums` below
   * rather than being forced into the boolean list. That was one inline
   * special case while there was one of them; a second is what makes it a
   * table. Both lists are validated the same way, and an unknown key or a
   * value outside a column's set is a 400 either way, so a typo can never
   * look like a successful write.
   */
  app.post('/api/me/prefs', (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields: [key: string, apply: (on: boolean) => void][] = [
      ['ladderListed', (on) => stmtSetLadderListed.run(on ? 1 : 0, user.id)],
      ['autoClaim', (on) => stmtSetAutoClaim.run(on ? 1 : 0, user.id)],
      ['bidFeedback', (on) => stmtSetBidFeedback.run(on ? 1 : 0, user.id)],
      ['betaFeatures', (on) => stmtSetBetaFeatures.run(on ? 1 : 0, user.id)],
      ['doubleTapBid', (on) => stmtSetDoubleTapBid.run(on ? 1 : 0, user.id)],
      ['foilTrumps', (on) => stmtSetFoilTrumps.run(on ? 1 : 0, user.id)],
    ];
    const enums: [key: string, values: string[], apply: (value: string) => void][] = [
      ['trickClearMode', ['auto', 'tap'], (v) => stmtSetTrickClearMode.run(v, user.id)],
      ['trumpPlacement', ['suit', 'left'], (v) => stmtSetTrumpPlacement.run(v, user.id)],
    ];
    const booleans = new Set(fields.map(([key]) => key));
    const choices = new Map(enums.map(([key, values]) => [key, values]));
    for (const key of Object.keys(body)) {
      const values = choices.get(key);
      if (values) {
        if (typeof body[key] !== 'string' || !values.includes(body[key] as string)) {
          return reply.code(400).send({ error: `${key} must be ${values.map((v) => `"${v}"`).join(' or ')}` });
        }
        continue;
      }
      if (!booleans.has(key)) return reply.code(400).send({ error: `unknown preference: ${key}` });
      if (typeof body[key] !== 'boolean') return reply.code(400).send({ error: `${key} must be a boolean` });
    }
    for (const [key, apply] of fields) {
      if (key in body) apply(body[key] as boolean);
    }
    for (const [key, , apply] of enums) {
      if (key in body) apply(body[key] as string);
    }
    const row = stmtUserById.get(user.id) as UserRow;
    return reply.send({
      ladderListed: row.ladder_listed !== 0,
      autoClaim: row.auto_claim !== 0,
      bidFeedback: row.bid_feedback !== 0,
      betaFeatures: row.beta_features !== 0,
      doubleTapBid: row.double_tap_bid !== 0,
      trickClearMode: row.trick_clear_mode,
      trumpPlacement: row.trump_placement,
      foilTrumps: row.foil_trumps !== 0,
    });
  });

  // First-crossing tour completion (or skip). Idempotent — the stamp is
  // write-once, so re-walking the tour from its revisit route never moves it.
  app.post('/api/me/onboarded', (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    stmtSetOnboarded.run(user.id);
    return reply.send({ ok: true });
  });

  // First-login (and handle-change) endpoint: claims a case-insensitively unique display handle.
  app.post('/api/handle', (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { handle } = (req.body ?? {}) as { handle?: string };
    const result = validateHandle(handle ?? '');
    if (!result.ok) return reply.code(400).send({ error: result.error });
    if (stmtHandleTaken.get(result.key, user.id)) return reply.code(409).send({ error: 'handle already taken' });
    stmtSetHandle.run(result.handle, result.key, user.id);
    return reply.send({
      user: { id: user.id, handle: result.handle, picture: user.picture, elo: user.elo, onboardedAt: user.onboarded_at },
    });
  });
}
