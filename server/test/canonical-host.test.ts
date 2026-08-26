import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { freshDbEnv } from './helpers.js';

/**
 * The noindex guard on a real deployment's NON-CANONICAL hostnames.
 *
 * Production answers on two: `bridge.brannon.online` (canonical, fronted by
 * Cloudflare) and the unproxied Fly origin `nickel-bridge.fly.dev`. The second
 * is neither DEMO nor DEV_AUTH, so it served the production robots.txt with
 * `Allow: /` and nothing else — a complete, fully indexable duplicate of the
 * real site under a second hostname, competing with it in search.
 *
 * These live in their own file rather than in discoverability.test.ts because
 * src/config.ts parses process.env.BASE_URL exactly once, at module load: a
 * canonical host has to exist BEFORE src/app.js is first imported, and that
 * suite deliberately runs with none (so it covers the opposite case — no
 * BASE_URL, therefore no hostname is non-canonical and nothing is marked).
 * The assignment therefore sits above the dynamic import, the same shape
 * oauth.test.ts uses for the same reason.
 */
freshDbEnv('canonical-host');
process.env.BASE_URL = 'https://bridge.example.test';
// freshDbEnv turns DEV_AUTH on for every suite, which is the preview-shaped
// case — throwawayOrigin would then mark every response whatever the Host is,
// and none of the tests below would be testing what they claim to. Cleared at
// module scope, before any buildApp().
delete process.env.DEV_AUTH;
delete process.env.DEMO;
// A leftover WEB_DIST from another suite in this worker would change which
// routes exist; none of these tests want the static SPA.
delete process.env.WEB_DIST;

const CANONICAL = 'bridge.example.test';
/** The unproxied Fly origin — the same app, a different hostname. */
const ORIGIN_HOST = 'nickel-bridge.fly.dev';

/** A spread of route kinds: static text, an open API read, the health probe. */
const PATHS = ['/robots.txt', '/api/leaderboard', '/health'];

let app: FastifyInstance;
let isCanonicalHost: (host: string | undefined) => boolean;
beforeAll(async () => {
  const { buildApp } = await import('../src/app.js');
  ({ isCanonicalHost } = await import('../src/config.js'));
  app = await buildApp();
});

const get = (host: string, url: string) => app.inject({ method: 'GET', url, headers: { host } });

describe('noindex on a non-canonical hostname', () => {
  it('marks every response served under the unproxied origin host', async () => {
    for (const url of PATHS) {
      const res = await get(ORIGIN_HOST, url);
      expect(res.headers['x-robots-tag'], url).toBe('noindex, nofollow');
    }
  });

  it('leaves the canonical host completely unchanged', async () => {
    for (const url of PATHS) {
      const res = await get(CANONICAL, url);
      expect(res.headers['x-robots-tag'], url).toBeUndefined();
    }
  });

  // A Host header is case-insensitive; a string compare is not. Getting this
  // wrong would noindex the real site for anyone whose client happens to send
  // the hostname capitalised.
  it('treats a mixed-case canonical Host as canonical', async () => {
    const res = await get('Bridge.Example.Test', '/robots.txt');
    expect(res.headers['x-robots-tag']).toBeUndefined();
  });

  // The header is one header. It is set from a single hook that covers both the
  // throwaway-origin case and this one, so there is no path that sets it twice
  // — which would arrive as a repeated header rather than an overwrite if the
  // header name ever changed to one Fastify appends.
  it('sets exactly one header value, never a list', async () => {
    const res = await get(ORIGIN_HOST, '/robots.txt');
    expect(typeof res.headers['x-robots-tag']).toBe('string');
  });

  /**
   * The hard constraint. robots.txt's BYTES must not vary by hostname.
   *
   * scripts/cloudflare.mjs --snapshot (before every deploy) and --purge --since
   * (after) hash what `<app>.fly.dev` serves for a sample of URLs, /robots.txt
   * included, and purge Cloudflare's cache for whatever moved. If this host
   * served a constant disallow-all instead, a genuine SITE_ROUTES change would
   * move the canonical host's robots.txt while leaving the sampled bytes
   * identical: nothing purged, and the edge serving a stale robots.txt for the
   * full 30-day TTL. Headers are not part of that hash; the body is.
   */
  it('serves byte-identical robots.txt on both hostnames', async () => {
    const canonical = await get(CANONICAL, '/robots.txt');
    const origin = await get(ORIGIN_HOST, '/robots.txt');
    expect(origin.body).toBe(canonical.body);
    expect(origin.body).toContain('Allow: /');
    expect(origin.body).not.toMatch(/^Disallow: \/$/m);
  });
});

/**
 * The compare itself, which auth.ts's OAuth entry point shares with the hook
 * above — two hand-written copies of one lowercase host test is the drift this
 * codebase spends its comments avoiding, and both directions of it are silent.
 * The null-BASE_URL branch is pinned end to end in discoverability.test.ts.
 */
describe('isCanonicalHost', () => {
  it('matches the configured host regardless of case', () => {
    expect(isCanonicalHost(CANONICAL)).toBe(true);
    expect(isCanonicalHost('BRIDGE.EXAMPLE.TEST')).toBe(true);
  });

  it('rejects any other host, and a request with no Host at all', () => {
    expect(isCanonicalHost(ORIGIN_HOST)).toBe(false);
    expect(isCanonicalHost('bridge.example.test.evil.example')).toBe(false);
    expect(isCanonicalHost(undefined)).toBe(false);
  });
});
