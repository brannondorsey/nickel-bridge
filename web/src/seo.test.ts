/**
 * The one join in the search-engine surface a build step can't derive.
 *
 * robots.txt and the sitemap both fall out of server/src/seo.ts's SITE_ROUTES
 * (see that file, and the checks at the bottom of web/scripts/prerender.mjs),
 * so they cannot contradict each other. What no derivation can check is
 * whether the table's `public` column is TRUE — that's app behaviour, decided
 * by App.tsx's sign-in gate. This suite is that check.
 *
 * It matters in both directions. A route that becomes public without a row
 * here gets crawled as the SPA shell: an empty #root wearing the home page's
 * title and OG tags, a thin duplicate of / competing with / itself. A row
 * that claims a route is public when the gate still redirects it puts a
 * sign-in wall in the search index under a term page's name.
 *
 * The import reaches across the workspace into server/src — deliberately, and
 * only from a test. seo.ts is dependency-free and Node/DOM-free so it costs
 * nothing to typecheck here; nothing in the web BUNDLE may import it (the
 * same rule packages/core lives under).
 */
/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
// The source text, not the module: the last test below reads the router's
// route list out of it. `?raw` is Vite's own mechanism — web has no
// @types/node, so node:fs is not an option here.
import appSource from './App.tsx?raw';
import { SITE_ROUTES, covers, isDisallowed, samplePath } from '../../server/src/seo';
import { isPublicPath } from './App';

describe('the route table matches the app it describes', () => {
  it.each(SITE_ROUTES.filter((r) => r.spa))('agrees about who may read $path', (route) => {
    // A '/x/*' row stands for every path under it, so test a sample: the
    // gate is written as a prefix check, and so is robots.txt.
    expect(isPublicPath(samplePath(route.path))).toBe(route.public);
  });

  // Indexed implies public — a crawler follows no redirects into a session.
  it('never marks a gated route indexed', () => {
    for (const route of SITE_ROUTES) {
      if (route.indexed) expect(route.public, route.path).toBe(true);
    }
  });

  // The derivation makes this structural rather than aspirational; assert it
  // anyway, because it is the property everything else here is protecting.
  it('disallows exactly the routes it does not index', () => {
    for (const route of SITE_ROUTES) {
      expect(isDisallowed(samplePath(route.path)), route.path).toBe(!route.indexed);
    }
  });

  // Guards against the one edit that would be catastrophic rather than
  // merely wrong: a `/` row flipped to indexed: false emits `Disallow: /`
  // and deindexes the entire site, glossary included.
  it('leaves the front door open', () => {
    expect(isDisallowed('/')).toBe(false);
    expect(isDisallowed('/glossary/finesse')).toBe(false);
  });

  // The upkeep clause: read the routes out of App.tsx itself, so ADDING one
  // fails this test until the table has an answer for it. A hand-written list
  // of paths here would only ever re-state what the table already says, and
  // would go stale in exactly the case that matters — a new route nobody
  // thought about the crawler for.
  it('covers every route the router declares', () => {
    const declared = [...appSource.matchAll(/<Route path="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((p) => p !== '*'); // the catch-all is the app's own 404 screen
    expect(declared.length).toBeGreaterThan(5); // the regex still finds them
    for (const route of declared) {
      // /players/:id stands for a real id; the table matches by prefix.
      const pathname = route.replace(/:[^/]+/g, 'sample');
      const covered = SITE_ROUTES.some((r) => covers(r.path, pathname));
      expect(covered, `${route} has no row in SITE_ROUTES (server/src/seo.ts)`).toBe(true);
    }
  });
});
