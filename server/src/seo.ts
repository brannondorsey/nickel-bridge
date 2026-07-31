/**
 * The search-engine surface, as one table.
 *
 * Three files used to answer "is this URL crawlable?" independently, and they
 * had to agree: robots.txt (here in the server), the sitemap and the
 * prerendered pages (web/scripts/prerender.mjs), and the sign-in gate
 * (web/src/App.tsx's isPublicPath). Nothing checked that they did. The
 * failure mode is quiet in every direction — a sitemap entry for a
 * disallowed URL is a contradiction a crawler reports back at you weeks
 * later; a newly public route nobody added to either list gets crawled as
 * the SPA shell, an empty #root wearing the home page's title and OG tags,
 * i.e. a thin duplicate of `/` competing with `/` itself.
 *
 * So both machine-readable outputs now come from SITE_ROUTES below:
 *   - robots.txt's Disallow list is derived here (`robotsTxt`), from exactly
 *     the routes marked `indexed: false` — which makes "indexed and
 *     disallowed" unrepresentable rather than merely tested;
 *   - the sitemap is built in web/scripts/prerender.mjs, which imports this
 *     table and refuses to emit a sitemap that disagrees with it.
 * The third file can't be derived — App.tsx's gate is app behaviour, not
 * metadata — so it's cross-checked instead: web/src/seo.test.ts asserts
 * isPublicPath() agrees with the `public` column, sample path by sample path.
 *
 * This module is deliberately dependency-free and DOM/Node-free: the web
 * build script imports it directly from source (Node strips the types), and
 * a web test typechecks it under web/tsconfig.json, which has no @types/node.
 * Keep it that way — no `process`, no imports, no fastify.
 *
 * ADDING A ROUTE. Add a row. If it needs an account, `public: false` and
 * you're done. If it doesn't, decide `indexed` on its merits — is there
 * durable prose at that URL that someone might search for? — and if the
 * answer is yes, prerender it in prerender.mjs, which is where the build
 * will tell you the sitemap is now short an entry.
 */

/** One URL space the site answers for. */
export type SiteRoute = {
  /**
   * The path as the router declares it, with a trailing `/*` meaning "and
   * everything under it". Matched by prefix for robots.txt, so it is the
   * literal text that lands after `Disallow: `.
   */
  path: string;
  /**
   * Readable without an account — web/src/App.tsx's isPublicPath. False for
   * the machine endpoints too, which never reach the router at all.
   */
  public: boolean;
  /**
   * Prerendered to static HTML and listed in the sitemap. Implies `public`,
   * and implies a real page for a crawler that runs no JavaScript: an
   * indexed route that is only the SPA shell would be a duplicate of `/`.
   */
  indexed: boolean;
  /** True for routes the SPA's <Routes> owns; false for /api/ and /auth/. */
  spa: boolean;
};

/**
 * Public and indexable are separate decisions, and this table is where the
 * difference is written down. Everything not listed falls through to the SPA
 * shell and the app's own not-found screen.
 */
export const SITE_ROUTES: readonly SiteRoute[] = [
  // ---- indexed: prerendered, in the sitemap, invited in by robots.txt ----
  // The front door and the ledger. Both are static prose that answers a
  // search query on its own, which is the whole test for belonging here.
  { path: '/', public: true, indexed: true, spa: true },
  { path: '/glossary', public: true, indexed: true, spa: true },
  { path: '/glossary/*', public: true, indexed: true, spa: true },

  // ---- public, but kept out of the index ----
  // Real people's handles, ratings and daily activity. Being readable by
  // someone who follows a link is a different thing from being findable by
  // name in a search engine.
  { path: '/players/*', public: true, indexed: false, spa: true },
  // Public, but not prerendered: a crawler that doesn't run JavaScript gets
  // the SPA shell, and a live ladder is not durable prose anyway. Prerender
  // either of these and it can flip to `indexed: true` — robots.txt and the
  // sitemap both follow from this column in the same edit.
  { path: '/leaderboard', public: true, indexed: false, spa: true },
  { path: '/tour', public: true, indexed: false, spa: true },

  // ---- gated: a crawler gets the landing page or a 401 ----
  // Nothing to index, and fetching them burns crawl budget that should go to
  // the glossary.
  { path: '/t/*', public: false, indexed: false, spa: true },
  // When real people sit down to play, and for how long. The ladder next to it
  // is public because it's a bounded list of handles and ratings; this is a
  // behavioural record, and it stays behind the gate.
  { path: '/activity', public: false, indexed: false, spa: true },
  // Your record beside another player's — scoped to the VIEWER, which is
  // exactly what the public list above must never contain. Note the path is
  // NOT /players/:id/compare: App.tsx's isPublicPath matches the /players/
  // prefix with startsWith, so mounting it there would have made a gated screen
  // public while this table and that gate went on agreeing with each other.
  // Must stay `/compare/*` — covers() is exact unless the row ends in /*, so a
  // bare `/compare` row would not cover `/compare/7` and seo.test.ts would fail.
  { path: '/compare/*', public: false, indexed: false, spa: true },
  // One person's own preferences. Nothing to read here without their session.
  { path: '/settings', public: false, indexed: false, spa: true },
  { path: '/scenarios', public: false, indexed: false, spa: true },
  { path: '/api/*', public: false, indexed: false, spa: false },
  { path: '/auth/*', public: false, indexed: false, spa: false },
];

/**
 * Does a route row cover this URL path? `/x/*` covers everything under `/x/`;
 * `/x` is exact. Exported because both consumers need the table's matching
 * semantics — the prerender's sitemap checks and the App.tsx cross-check —
 * and two hand-rolled copies of this rule is the very drift the table exists
 * to prevent.
 */
export function covers(routePath: string, pathname: string): boolean {
  return routePath.endsWith('/*') ? pathname.startsWith(routePath.slice(0, -1)) : pathname === routePath;
}

/**
 * The robots.txt path for a route: `/x/*` disallows the prefix `/x/`, `/x`
 * disallows `/x` (and, by robots.txt's prefix semantics, anything starting
 * with it — which is what we want for `/leaderboard`).
 */
export function robotsPath(path: string): string {
  return path.endsWith('/*') ? path.slice(0, -1) : path;
}

/** Every route a crawler is asked to stay out of, in table order. */
export function crawlerDisallow(): string[] {
  return SITE_ROUTES.filter((r) => !r.indexed).map((r) => robotsPath(r.path));
}

/**
 * Does robots.txt disallow this URL path? Prefix semantics, the same rule
 * crawlers apply — used by the prerender build step to refuse a sitemap that
 * lists a URL this file has told crawlers not to fetch.
 */
export function isDisallowed(pathname: string): boolean {
  return crawlerDisallow().some((p) => pathname.startsWith(p));
}

/** Sample path that exercises a pattern, for the App.tsx cross-check. */
export function samplePath(path: string): string {
  return path.endsWith('/*') ? `${path.slice(0, -1)}sample` : path;
}

/**
 * robots.txt itself.
 *
 * `throwaway` is the demo app and every PR preview (DEMO=1 or DEV_AUTH=1,
 * which invariant 5 forbids in production): they serve a byte-identical
 * build from their own hostnames, so they must never compete with the real
 * site in the index — shut the door completely, and offer no sitemap.
 */
export function robotsTxt(opts: { throwaway: boolean; origin: string }): string {
  if (opts.throwaway) return 'User-agent: *\nDisallow: /\n';
  return [
    'User-agent: *',
    'Allow: /',
    ...crawlerDisallow().map((p) => `Disallow: ${p}`),
    '',
    `Sitemap: ${opts.origin}/sitemap.xml`,
    '',
  ].join('\n');
}
