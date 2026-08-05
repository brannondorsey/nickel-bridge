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
 *   2. the CSP carries no resource allowlist. That is a deliberate limit rather
 *      than an oversight (see contentSecurityPolicy's doc comment), and the
 *      failure it prevents — a directive that blocks a font, a script or a
 *      fetch only in a production browser — is invisible to every other test in
 *      this repo, since Vite's dev server sends no header and jsdom ignores one;
 *   3. HSTS is conditional on an https origin, because it is the one header
 *      here a browser REMEMBERS: sent from http://localhost it would be
 *      ignored, but the reasoning only holds while it stays deliberate.
 */
let buildApp: () => Promise<FastifyInstance>;

/** The real SPA shell — the file the built one is generated from. */
const webIndexHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../web/index.html'), 'utf8');

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

  it('omits HSTS on an http origin and sends a year of it on https', async () => {
    const { securityHeaders } = await import('../src/security.js');
    expect(securityHeaders({ hsts: false })['strict-transport-security']).toBeUndefined();
    expect(securityHeaders({ hsts: true })['strict-transport-security']).toBe('max-age=31536000');
    // No includeSubDomains: nothing lives under either app's own host, so it
    // would be a no-op. Not preloaded either: the preload list is keyed on the
    // registrable domain, and brannon.online carries hosts this repo knows
    // nothing about.
    expect(securityHeaders({ hsts: true })['strict-transport-security']).not.toContain('preload');
  });
});

describe('the content security policy', () => {
  it('forbids what the app never does', async () => {
    const { contentSecurityPolicy } = await import('../src/security.js');
    const csp = contentSecurityPolicy();
    for (const directive of [
      `frame-ancestors 'none'`,
      `base-uri 'none'`,
      `object-src 'none'`,
      `form-action 'self'`,
    ]) {
      expect(csp).toContain(directive);
    }
  });

  /**
   * The guard on the limit itself. Every directive above governs a capability
   * the app doesn't use, so none of them can go stale; a fetch/script/style
   * directive is the opposite — it is a second copy of what the app loads,
   * enforced only in a production browser, and it goes stale the first time
   * someone adds a font host or an embedded widget. Re-adding one deliberately
   * means deciding to carry that (start with Content-Security-Policy-Report-Only
   * and somewhere for the reports to land) and updating this test with the
   * reasoning — not deleting it because it went red.
   */
  it('carries no resource allowlist that could stale out and block a page', async () => {
    const { contentSecurityPolicy } = await import('../src/security.js');
    const csp = contentSecurityPolicy();
    for (const directive of [
      'default-src',
      'script-src',
      'style-src',
      'img-src',
      'font-src',
      'connect-src',
      'media-src',
      'worker-src',
    ]) {
      expect(csp, `${directive} would gate resource loading`).not.toContain(directive);
    }
  });
});
