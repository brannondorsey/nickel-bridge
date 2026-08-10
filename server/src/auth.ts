import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DIFFICULTIES, type SettableDifficulty } from '@bridge/ai';
import { COOKIES_SECURE, PUBLIC_ORIGIN } from './config.js';
import { db, UserRow } from './db.js';
import { compareMin } from './compare.js';
import { validateHandle } from './handle.js';
import { completedBoardCount } from './stats.js';
import { medalProgressFor } from './medals.js';
import { provisionalMin } from './tournaments.js';

/**
 * Google OAuth (authorization-code flow) with open signup, plus cookie
 * sessions stored in SQLite. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
 * BASE_URL. For local development without Google credentials set
 * DEV_AUTH=1 to enable name-only login at POST /auth/dev.
 */
const SESSION_COOKIE = 'session';
const SESSION_TTL_S = 90 * 24 * 3600;

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

export function registerAuthRoutes(app: FastifyInstance): void {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = `${PUBLIC_ORIGIN}/auth/google/callback`;

  app.get('/auth/google', (req, reply) => {
    if (!clientId) return reply.code(500).send({ error: 'GOOGLE_CLIENT_ID not configured' });
    const state = randomBytes(16).toString('base64url');
    reply.setCookie('oauth_state', state, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 600 });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get('/auth/google/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state || state !== req.cookies['oauth_state']) {
      return reply.code(400).send({ error: 'bad oauth state' });
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
      return reply.code(502).send({ error: 'token exchange failed' });
    }
    const tokens = (await tokenRes.json()) as { access_token: string };
    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (!infoRes.ok) return reply.code(502).send({ error: 'userinfo failed' });
    const info = (await infoRes.json()) as { sub: string; email?: string; name?: string; picture?: string };
    const user = upsertGoogleUser(info.sub, info.email ?? null, info.name ?? info.email ?? 'Player', info.picture ?? null);
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
   * - betaFeatures — opt in to features still being tried out (currently:
   *   Analyze). Off by default in production, on by default on preview/demo
   *   deployments — see the beta_features migration in db.ts for why. This
   *   is the one row in Settings that GRANTS access rather than describing a
   *   preference, so it stays visible and settable the same way as the rest.
   * - doubleTapBid — whether a second tap on the already-selected call in the
   *   bid box submits it, without pressing the confirm CTA. Defaults false,
   *   unlike the three above: this is the one preference that changes
   *   existing accounts' behaviour on purpose, since accidental bids from the
   *   shortcut are exactly what shipping it off by default fixes — see the
   *   double_tap_bid migration in db.ts.
   * - trickClearMode — how a completed trick leaves the table: 'auto' (times
   *   out on its own, the shipped behaviour) or 'tap' (holds until the
   *   player taps the trick area). The one preference here that isn't a
   *   boolean — see the trick_clear_mode migration in db.ts for why it's a
   *   TEXT enum — so it's validated and applied separately from `fields`
   *   below rather than forcing a string into that boolean-only list.
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
    ];
    const known = new Set(fields.map(([key]) => key));
    for (const key of Object.keys(body)) {
      if (key === 'trickClearMode') {
        if (body[key] !== 'auto' && body[key] !== 'tap') {
          return reply.code(400).send({ error: 'trickClearMode must be "auto" or "tap"' });
        }
        continue;
      }
      if (!known.has(key)) return reply.code(400).send({ error: `unknown preference: ${key}` });
      if (typeof body[key] !== 'boolean') return reply.code(400).send({ error: `${key} must be a boolean` });
    }
    for (const [key, apply] of fields) {
      if (key in body) apply(body[key] as boolean);
    }
    if ('trickClearMode' in body) stmtSetTrickClearMode.run(body.trickClearMode, user.id);
    const row = stmtUserById.get(user.id) as UserRow;
    return reply.send({
      ladderListed: row.ladder_listed !== 0,
      autoClaim: row.auto_claim !== 0,
      bidFeedback: row.bid_feedback !== 0,
      betaFeatures: row.beta_features !== 0,
      doubleTapBid: row.double_tap_bid !== 0,
      trickClearMode: row.trick_clear_mode,
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
