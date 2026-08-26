import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { freshDbEnv } from './helpers.js';

/**
 * The Google sign-in round trip, and the four ways it used to fail.
 *
 * Production shipped for weeks with a callback that answered every one of
 * them with the same `400 {"error":"bad oauth state"}` — a raw JSON dead end.
 * Players reported it as "the site is broken", which from where they sat it
 * was: three of the four causes were transient and none of them said so, or
 * offered anything to press.
 *
 * These tests drive the real routes through app.inject() with a cookie jar
 * per hostname, because the headline bug is precisely a cookie/hostname
 * split that a single-host test can never see: `/auth/google` served on one
 * host sets the state cookie there, while the redirect_uri it hands Google is
 * built from BASE_URL and comes back somewhere else. Google itself is stubbed
 * at fetch, so the success path is exercised end to end without a network.
 *
 * BASE_URL has to be set before src/config.ts is first imported — it parses
 * process.env once, at module load — hence the assignment above the dynamic
 * import rather than in a beforeAll.
 */
freshDbEnv('oauth');
process.env.BASE_URL = 'https://bridge.example.test';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

const CANONICAL = 'bridge.example.test';
/** The unproxied Fly origin — the same app, a different hostname. */
const ORIGIN_HOST = 'nickel-bridge.fly.dev';

let app: FastifyInstance;
beforeAll(async () => {
  const { buildApp } = await import('../src/app.js');
  app = await buildApp();
});
afterEach(() => vi.unstubAllGlobals());

/**
 * One browser: cookies kept per hostname, exactly as a browser scopes them.
 *
 * Sharing one jar across hosts is the mistake this whole suite exists to
 * catch, so the jar refuses to make it — `cookieFor` only ever returns what
 * that host itself set.
 */
class Browser {
  private jars = new Map<string, Map<string, string>>();

  private jar(host: string): Map<string, string> {
    let j = this.jars.get(host);
    if (!j) this.jars.set(host, (j = new Map()));
    return j;
  }

  cookieFor(host: string): string {
    return [...this.jar(host)].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async get(host: string, url: string) {
    const cookie = this.cookieFor(host);
    const res = await app.inject({ method: 'GET', url, headers: { host, ...(cookie ? { cookie } : {}) } });
    for (const raw of [res.headers['set-cookie'] ?? []].flat()) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      // An expiry in the past is a deletion, which is how clearCookie lands.
      if (/expires=Thu, 01 Jan 1970/i.test(raw)) this.jar(host).delete(name);
      else this.jar(host).set(name, value);
    }
    return res;
  }

  async post(host: string, url: string, body: unknown) {
    const cookie = this.cookieFor(host);
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { host, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      payload: JSON.stringify(body),
    });
    for (const raw of [res.headers['set-cookie'] ?? []].flat()) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      this.jar(host).set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return res;
  }
}

/** The `state` Google was told to hand back. */
function stateFromAuthRedirect(location: string): string {
  return new URL(location).searchParams.get('state')!;
}

/** Stub Google's token + userinfo endpoints for one successful sign-in. */
function stubGoogle(sub = 'google-sub-1', name = 'Stefan') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (href.includes('openidconnect.googleapis.com')) {
        return new Response(JSON.stringify({ sub, email: `${sub}@example.test`, name }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${href}`);
    }),
  );
}

/**
 * A whole sign-in, the way a browser performs one: start on `startHost`,
 * follow our own redirects, take the state Google is given, and come back to
 * the callback on the host named in redirect_uri (which is what Google does —
 * it uses the registered URI, never wherever the visitor happened to start).
 */
async function signIn(b: Browser, startHost: string) {
  let res = await b.get(startHost, '/auth/google');
  let host = startHost;
  // The canonical-host bounce, if this deployment issued one.
  while (res.statusCode === 302 && !res.headers.location!.startsWith('https://accounts.google.com')) {
    const next = new URL(res.headers.location as string, `https://${host}`);
    host = next.host;
    res = await b.get(host, next.pathname + next.search);
  }
  const authUrl = new URL(res.headers.location as string);
  const state = stateFromAuthRedirect(res.headers.location as string);
  const callback = new URL(authUrl.searchParams.get('redirect_uri')!);
  const done = await b.get(callback.host, `${callback.pathname}?code=auth-code&state=${state}`);
  return { done, callbackHost: callback.host, state };
}

describe('the cross-host split (the bug players reported)', () => {
  it('starts the flow on the canonical host no matter which hostname was asked', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/google', headers: { host: ORIGIN_HOST } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://bridge.example.test/auth/google');
    // Crucially it hands out NO state here: a cookie set on this hostname is
    // exactly what could never come back.
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('signs in end to end when the visitor arrives on the unproxied Fly origin', async () => {
    stubGoogle('sub-flydev');
    const b = new Browser();
    const { done, callbackHost } = await signIn(b, ORIGIN_HOST);
    expect(callbackHost).toBe(CANONICAL);
    // Signed in, and landed on the canonical host where the session lives.
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe('/');
    const me = await b.get(CANONICAL, '/api/me');
    expect(me.json().user).not.toBeNull();
  });

  it('treats a mixed-case Host as the canonical host, not a second hop', async () => {
    // Host headers are case-insensitive; a string compare is not. Some old
    // bookmarks and crawlers send one, and it would otherwise bounce once
    // through here for nothing.
    const res = await app.inject({
      method: 'GET',
      url: '/auth/google',
      headers: { host: CANONICAL.toUpperCase() },
    });
    expect(res.headers.location).toContain('accounts.google.com');
  });

  it('is a no-op on a deployment whose visitors are already on the canonical host', async () => {
    stubGoogle('sub-canonical');
    const b = new Browser();
    const { done } = await signIn(b, CANONICAL);
    expect(done.headers.location).toBe('/');
    expect(b.cookieFor(CANONICAL)).toContain('session=');
  });
});

describe('the state cookie', () => {
  it('is Secure, httpOnly and lives long enough for a real Google sign-in', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/google', headers: { host: CANONICAL } });
    const setCookie = [res.headers['set-cookie'] ?? []].flat().find((c) => c.startsWith('oauth_state='))!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    // The session cookie beside it always had this; this one did not.
    expect(setCookie).toContain('Secure');
    // Ten minutes did not cover an account chooser plus a second factor.
    expect(setCookie).toContain('Max-Age=1800');
  });

  it('keeps earlier attempts alive, so a second start does not void the first', async () => {
    const b = new Browser();
    const first = await b.get(CANONICAL, '/auth/google');
    const firstState = stateFromAuthRedirect(first.headers.location as string);
    // Back to the site and press it again — a second tab, or the account
    // chooser's back button. This used to overwrite the only slot there was.
    const second = await b.get(CANONICAL, '/auth/google');
    const secondState = stateFromAuthRedirect(second.headers.location as string);
    expect(secondState).not.toBe(firstState);

    stubGoogle('sub-two-tabs');
    // Finish the leg that was started FIRST.
    const done = await b.get(CANONICAL, `/auth/google/callback?code=c&state=${firstState}`);
    expect(done.headers.location).toBe('/');
  });

  it('remembers a bounded number of attempts, oldest dropped first', async () => {
    const b = new Browser();
    const states: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await b.get(CANONICAL, '/auth/google');
      states.push(stateFromAuthRedirect(res.headers.location as string));
    }
    const held = b.cookieFor(CANONICAL);
    expect(held).toContain(states[3]);
    expect(held).toContain(states[1]);
    // The fourth start pushed the first out — the cookie is not unbounded.
    expect(held).not.toContain(states[0]);
  });

  it('spends a state on success, so a replayed callback cannot re-authenticate', async () => {
    stubGoogle('sub-replay');
    const b = new Browser();
    const { state } = await signIn(b, CANONICAL);
    expect(b.cookieFor(CANONICAL)).not.toContain('oauth_state');
    // Someone re-opening the callback URL out of history gets the front door,
    // not a second session off a spent code.
    const replay = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=auth-code&state=${state}`,
      headers: { host: CANONICAL },
    });
    expect(replay.headers.location).toBe('/?signin=expired');
  });
});

describe('failures are told apart, and none of them is a dead end', () => {
  it('treats a visitor who cancelled at Google as a choice, not a bad state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/google/callback?error=access_denied&state=whatever',
      headers: { host: CANONICAL },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/?signin=cancelled');
  });

  it('sends an expired or unknown state back to the front door', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/google/callback?code=c&state=not-a-state-we-issued',
      headers: { host: CANONICAL },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/?signin=expired');
  });

  it('never answers with the old JSON dead end', async () => {
    for (const url of [
      '/auth/google/callback',
      '/auth/google/callback?error=access_denied',
      '/auth/google/callback?code=c&state=stale',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: { host: CANONICAL } });
      expect(res.statusCode).toBe(302);
      expect(res.body).not.toContain('bad oauth state');
    }
  });

  it('reports a Google-side failure as retryable rather than a 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const b = new Browser();
    const start = await b.get(CANONICAL, '/auth/google');
    const state = stateFromAuthRedirect(start.headers.location as string);
    const res = await b.get(CANONICAL, `/auth/google/callback?code=c&state=${state}`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/?signin=failed');
  });

  it.each([
    ['a cancelled second tab', '/auth/google/callback?error=access_denied&state=stale'],
    ['a state nothing remembers', '/auth/google/callback?code=c&state=stale'],
  ])('does not tell an already-signed-in visitor a sign-in failed — %s', async (_label, url) => {
    const b = new Browser();
    await b.post(CANONICAL, '/auth/dev', { name: `Margaret-${url.length}` });
    const res = await b.get(CANONICAL, url);
    expect(res.headers.location).toBe('/');
  });

  it('extends that courtesy to a Google-side failure, not just a stale state', async () => {
    // The check began at two of the four failure exits and was absent from
    // the other two, which made the guarantee in CONTRIBUTING.md wider than
    // the code. It now lives in signInFailed, so no exit can skip it.
    const b = new Browser();
    await b.post(CANONICAL, '/auth/dev', { name: 'AlreadyIn' });
    const start = await b.get(CANONICAL, '/auth/google');
    const state = stateFromAuthRedirect(start.headers.location as string);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const res = await b.get(CANONICAL, `/auth/google/callback?code=c&state=${state}`);
    expect(res.headers.location).toBe('/');
  });

  it('leaves other in-flight attempts usable after one leg fails', async () => {
    const b = new Browser();
    const start = await b.get(CANONICAL, '/auth/google');
    const good = stateFromAuthRedirect(start.headers.location as string);
    await b.get(CANONICAL, '/auth/google/callback?code=c&state=some-other-stale-leg');
    stubGoogle('sub-survivor');
    const done = await b.get(CANONICAL, `/auth/google/callback?code=c&state=${good}`);
    expect(done.headers.location).toBe('/');
  });
});
