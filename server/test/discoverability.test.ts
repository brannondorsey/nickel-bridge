import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { freshDbEnv } from './helpers.js';

freshDbEnv('seo');

/**
 * Search-engine surface: robots.txt, the noindex guard on throwaway origins,
 * and the prerendered glossary pages.
 *
 * `throwawayOrigin` is read inside buildApp(), so each test sets DEMO/DEV_AUTH
 * and builds its own app rather than sharing one. freshDbEnv() turns DEV_AUTH
 * on for every other suite, which is exactly the preview-shaped case — the
 * production-shaped tests have to clear it explicitly.
 */
let buildApp: () => Promise<FastifyInstance>;
let webDist: string;

beforeAll(async () => {
  ({ buildApp } = await import('../src/app.js'));

  // A stand-in for a real `npm run build -w web` output: the SPA shell plus a
  // couple of prerendered pages. Building the real thing here would make the
  // suite depend on Vite having run.
  webDist = mkdtempSync(join(tmpdir(), 'bridge-seo-dist-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><div id="root"></div><script type="module"></script>');
  mkdirSync(join(webDist, 'glossary-static'));
  writeFileSync(join(webDist, 'glossary-static', 'index.html'), '<!doctype html>THE LEDGER INDEX');
  writeFileSync(join(webDist, 'glossary-static', 'finesse.html'), '<!doctype html>FINESSE PAGE');
  // Its own directory, not a file in glossary-static/: that directory is
  // listed to build the set of servable term pages, so a home page inside it
  // would also answer to /glossary/home.
  mkdirSync(join(webDist, 'home-static'));
  writeFileSync(join(webDist, 'home-static', 'index.html'), '<!doctype html>THE LANDING PAGE');
  process.env.WEB_DIST = webDist;
});

afterEach(() => {
  process.env.DEV_AUTH = '1';
  delete process.env.DEMO;
});

/** Production shape: neither throwaway flag set. */
async function productionApp(): Promise<FastifyInstance> {
  delete process.env.DEV_AUTH;
  delete process.env.DEMO;
  return buildApp();
}

describe('robots.txt', () => {
  it('invites crawlers in and points at the sitemap on the production app', async () => {
    const app = await productionApp();
    const res = await app.inject({ method: 'GET', url: '/robots.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Allow: /');
    expect(res.body).toMatch(/^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m);
    expect(res.body).not.toMatch(/^Disallow: \/$/m);
    await app.close();
  });

  // Two kinds of entry on this list, and conflating them is how it drifts.
  //
  // Gated routes are here because a crawler gets the landing page or a 401 —
  // the same thin page under different URLs. /leaderboard was missed the first
  // time precisely because it's the top-level route whose path shares no
  // prefix with the others.
  //
  // /leaderboard, /players/ and /tour are here for a second reason: they read
  // WITHOUT an account (App.tsx's isPublicPath) but none of them is
  // prerendered, so a crawler that doesn't run JavaScript gets the SPA shell —
  // an empty #root wearing the home page's title, description and OG tags.
  // Public is not the same decision as indexable.
  //
  // The list is DERIVED now, from SITE_ROUTES in src/seo.ts — flipping a route
  // to indexed: true takes it off here and puts it in the sitemap in one edit,
  // and neither list can be changed alone. Spelling the expected paths out
  // literally is the point of this test: it's the second opinion that makes an
  // accidental edit to that table show up as a failure rather than as a
  // quietly different robots.txt.
  it('disallows every route that has nothing worth indexing', async () => {
    const app = await productionApp();
    const { body } = await app.inject({ method: 'GET', url: '/robots.txt' });
    for (const path of ['/api/', '/auth/', '/t/', '/players/', '/leaderboard', '/scenarios', '/tour', '/activity']) {
      expect(body, path).toContain(`Disallow: ${path}`);
    }
    // ...and nothing that IS prerendered: those are the whole point.
    expect(body).not.toContain('Disallow: /glossary');
    expect(body).not.toMatch(/^Disallow: \/$/m);
    await app.close();
  });

  it('shuts the door completely on a DEMO or DEV_AUTH origin', async () => {
    for (const flag of ['DEMO', 'DEV_AUTH'] as const) {
      delete process.env.DEV_AUTH;
      delete process.env.DEMO;
      process.env[flag] = '1';
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/robots.txt' });
      expect(res.body, flag).toContain('Disallow: /');
      expect(res.body, flag).not.toContain('Sitemap:');
      await app.close();
    }
  });
});

describe('noindex header', () => {
  it('is absent in production', async () => {
    const app = await productionApp();
    const res = await app.inject({ method: 'GET', url: '/robots.txt' });
    expect(res.headers['x-robots-tag']).toBeUndefined();
    await app.close();
  });

  // A preview URL posted into a pull request is an inbound link, and an
  // indexable URL needs nothing more than that — robots.txt alone wouldn't stop it.
  it('marks every response on a throwaway origin', async () => {
    process.env.DEMO = '1';
    const app = await buildApp();
    for (const url of ['/robots.txt', '/api/me', '/glossary/finesse']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['x-robots-tag'], url).toBe('noindex, nofollow');
    }
    await app.close();
  });
});

// The site's front door is the URL most likely to be crawled, linked and
// unfurled, and until now it served an empty #root to every agent that can't
// run JavaScript. Registering GET / is also the one route that can collide
// with @fastify/static (it registers the prefix itself, not just prefix + '*'),
// so a boot-time FST_ERR_DUPLICATED_ROUTE would fail this whole suite — which
// is the point of testing it here, where WEB_DIST is real.
describe('prerendered landing page', () => {
  it('serves the static landing page at /, not the empty SPA shell', async () => {
    const app = await productionApp();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('THE LANDING PAGE');
    await app.close();
  });

  // It lives outside glossary-static/ precisely so it can't become a second
  // URL for the front page, filed under the ledger.
  it('does not leak in as a glossary term', async () => {
    const app = await productionApp();
    const res = await app.inject({ method: 'GET', url: '/glossary/home' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('THE LANDING PAGE');
    await app.close();
  });

  // index: false on the static plugin is what frees up `/`; every other file
  // is still served by name, and unmatched routes still fall to the shell.
  it('still serves ordinary static files and the SPA fallback', async () => {
    const app = await productionApp();
    expect((await app.inject({ method: 'GET', url: '/index.html' })).body).toContain('<div id="root">');
    const spa = await app.inject({ method: 'GET', url: '/t/12/b/1' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('<div id="root">');
    await app.close();
  });
});

describe('prerendered glossary', () => {
  it('serves the static term page, not the empty SPA shell', async () => {
    const app = await productionApp();
    const res = await app.inject({ method: 'GET', url: '/glossary/finesse' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('FINESSE PAGE');
    await app.close();
  });

  it('serves the static ledger index at /glossary', async () => {
    const app = await productionApp();
    const res = await app.inject({ method: 'GET', url: '/glossary' });
    expect(res.body).toContain('THE LEDGER INDEX');
    await app.close();
  });

  // A slug with no page is a dead end, and there are ~780 of them a crawler can
  // reach by guessing a deep-reference term. Answering 200 with the generic
  // shell makes every one look like a real page (a "soft 404"); the SPA still
  // boots off a 404 body and shows its own not-in-the-ledger sheet.
  it('404s a slug with no prerendered page, still serving the SPA shell', async () => {
    const app = await productionApp();
    const res = await app.inject({ method: 'GET', url: '/glossary/not-a-real-term' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('<div id="root">');
    await app.close();
  });

  // The slug is joined onto a filesystem path, so it must never be able to
  // name anything but a page this build emitted.
  it('cannot be walked out of its directory', async () => {
    const app = await productionApp();
    for (const url of ['/glossary/..%2F..%2Findex', '/glossary/%2e%2e%2findex']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).toContain('<div id="root">');
    }
    await app.close();
  });

  // ?term= is the form the app leaves a reader on, so it's the form that gets
  // shared. It must answer with the same term the client would show — otherwise
  // a shared definition unfurls as the whole glossary.
  it('serves the matching term page for /glossary?term=<slug>', async () => {
    const app = await productionApp();
    const res = await app.inject({ method: 'GET', url: '/glossary?term=finesse' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('FINESSE PAGE');
    await app.close();
  });

  // Unlike a bad path slug, a bad query is not a dead end — /glossary is a real
  // page whatever trails behind it.
  it('falls back to the ledger index for an unknown ?term=, without a 404', async () => {
    const app = await productionApp();
    for (const url of ['/glossary?term=not-a-real-term', '/glossary?term=index', '/glossary?term=']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain('THE LEDGER INDEX');
    }
    await app.close();
  });

  // /glossary/index would otherwise be a second URL serving the ledger page —
  // a duplicate for crawlers to split signals across.
  it('does not expose the index page under a second URL', async () => {
    const app = await productionApp();
    const res = await app.inject({ method: 'GET', url: '/glossary/index' });
    expect(res.body).not.toContain('THE LEDGER INDEX');
    await app.close();
  });
});
