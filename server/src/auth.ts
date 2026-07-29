import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DIFFICULTIES, type SettableDifficulty } from '@bridge/ai';
import { COOKIES_SECURE, PUBLIC_ORIGIN } from './config.js';
import { db, UserRow } from './db.js';
import { validateHandle } from './handle.js';

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
const stmtSetFastForward = db.prepare(`UPDATE users SET fast_forward = ? WHERE id = ?`);
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
 * and seeded bots go through here too, so key derivation (NFC-normalized
 * lowercase, see handle.ts) can never diverge between signup paths.
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
            fastForward: user.fast_forward !== 0,
          }
        : null,
      devAuth: process.env.DEV_AUTH === '1',
      googleAuth: Boolean(clientId),
      demo: process.env.DEMO === '1',
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
   * - fastForward — pacing of the claim replay. On the account and not in
   *   localStorage because it describes the person, not the browser; see the
   *   fast_forward migration in db.ts.
   */
  app.post('/api/me/prefs', (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields: [key: string, apply: (on: boolean) => void][] = [
      ['ladderListed', (on) => stmtSetLadderListed.run(on ? 1 : 0, user.id)],
      ['fastForward', (on) => stmtSetFastForward.run(on ? 1 : 0, user.id)],
    ];
    const known = new Set(fields.map(([key]) => key));
    for (const key of Object.keys(body)) {
      if (!known.has(key)) return reply.code(400).send({ error: `unknown preference: ${key}` });
      if (typeof body[key] !== 'boolean') return reply.code(400).send({ error: `${key} must be a boolean` });
    }
    for (const [key, apply] of fields) {
      if (key in body) apply(body[key] as boolean);
    }
    const row = stmtUserById.get(user.id) as UserRow;
    return reply.send({ ladderListed: row.ladder_listed !== 0, fastForward: row.fast_forward !== 0 });
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
