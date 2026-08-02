import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { freshDbEnv } from './helpers.js';

freshDbEnv('security');

/**
 * The response security headers (server/src/security.ts) and their wiring.
 *
 * Three things are worth a test here, and they fail in different ways:
 *   1. the headers reach EVERY response — the hook is the whole feature, and a
 *      route registered before it would quietly opt out;
 *   2. the CSP names the shell's pre-paint inline scripts by hash — get this
 *      wrong and the app still works, so nothing else would notice, but every
 *      night-mode visitor eats a light flash on first paint;
 *   3. HSTS is conditional on an https origin, because it is the one header
 *      here a browser REMEMBERS: sent from http://localhost it would be
 *      ignored, but the reasoning only holds while it stays deliberate.
 */
let buildApp: () => Promise<FastifyInstance>;

/** The real SPA shell — the file the built one is generated from. */
const webIndexHtml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../web/index.html'),
  'utf8',
);

beforeAll(async () => {
  ({ buildApp } = await import('../src/app.js'));
});

/** A stand-in for `npm run build -w web` output, carrying the real shell. */
function fakeDist(shell: string): string {
  const dist = mkdtempSync(join(tmpdir(), 'bridge-sec-dist-'));
  writeFileSync(join(dist, 'index.html'), shell);
  mkdirSync(join(dist, 'home-static'));
  writeFileSync(join(dist, 'home-static', 'index.html'), shell);
  return dist;
}

describe('inlineScriptHashes', () => {
  it('hashes executable inline scripts and skips the rest', async () => {
    const { inlineScriptHashes } = await import('../src/security.js');
    const hashes = inlineScriptHashes(
      [
        '<script src="/assets/app.js" type="module"></script>', // external: 'self' covers it
        '<script type="application/ld+json">{"@type":"Thing"}</script>', // data block, never executed
        '<script>console.log(1)</script>',
        '<script type="module">export {}</script>',
      ].join('\n'),
    );
    // sha256 of `console.log(1)` and `export {}`, base64 — the exact form a
    // browser compares against.
    expect(hashes).toEqual([
      "'sha256-CihokcEcBW4atb/CW/XWsvWwbTjqwQlE9nj9ii5ww5M='",
      "'sha256-9MXPm7eOhfFdwnGAJgY3zySyokvDngeIeDo6zMTd5hQ='",
    ]);
  });

  it('covers both of the real shell’s pre-paint scripts', () => {
    // web/index.html carries exactly two blocking inline scripts (theme and
    // suit palette) plus one JSON-LD data block. If that count changes, the
    // CSP has to change with it — which is the entire point of deriving the
    // hashes from the file rather than pinning them here.
    expect(webIndexHtml.match(/<script\b/g)?.length).toBe(4); // 2 inline + ld+json + the module tag
  });
});

describe('security headers on the wire', () => {
  it('sets them on API responses, static pages and errors alike', async () => {
    process.env.WEB_DIST = fakeDist(webIndexHtml);
    const app = await buildApp();
    for (const url of ['/health', '/api/leaderboard', '/', '/robots.txt', '/api/nope']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['x-frame-options'], url).toBe('DENY');
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['referrer-policy'], url).toBe('strict-origin-when-cross-origin');
      expect(String(res.headers['permissions-policy']), url).toContain('camera=()');
      expect(String(res.headers['content-security-policy']), url).toContain(`frame-ancestors 'none'`);
    }
    await app.close();
  });

  it('names the shell’s inline scripts by hash instead of opening the policy', async () => {
    process.env.WEB_DIST = fakeDist(webIndexHtml);
    const { inlineScriptHashes } = await import('../src/security.js');
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/' });
    const csp = String(res.headers['content-security-policy']);
    const hashes = inlineScriptHashes(webIndexHtml);
    expect(hashes.length).toBe(2);
    for (const hash of hashes) expect(csp).toContain(hash);
    // The concession that would make the hashes pointless.
    expect(csp).not.toContain(`script-src 'self' 'unsafe-inline'`);
    expect(csp).not.toContain(`'unsafe-eval'`);
    await app.close();
  });

  it('omits HSTS on an http origin and sends a year of it on https', async () => {
    const { securityHeaders } = await import('../src/security.js');
    expect(securityHeaders({ hsts: false })['strict-transport-security']).toBeUndefined();
    expect(securityHeaders({ hsts: true })['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
    // Not preloaded: the preload list is keyed on the registrable domain, and
    // brannon.online carries hosts this repo knows nothing about.
    expect(securityHeaders({ hsts: true })['strict-transport-security']).not.toContain('preload');
  });

  it('allows what the app actually loads, and nothing more', async () => {
    const { contentSecurityPolicy } = await import('../src/security.js');
    const csp = contentSecurityPolicy();
    expect(csp).toContain(`default-src 'self'`);
    // gtag.js (analytics.ts) is the one third-party script, and GA's
    // collectors the one third-party connection.
    expect(csp).toContain('script-src \'self\' https://www.googletagmanager.com');
    expect(csp).toContain('https://www.google-analytics.com');
    // Google account avatars — users.picture, rendered by Player/Compare.
    expect(csp).toContain('https://*.googleusercontent.com');
    // The directives whose absence would be a silent hole rather than a broken page.
    for (const directive of [`base-uri 'none'`, `object-src 'none'`, `form-action 'self'`, `frame-src 'none'`]) {
      expect(csp).toContain(directive);
    }
  });
});
