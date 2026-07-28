/**
 * Prerender the public pages to static HTML — the crawlable half of the app.
 *
 * This is a BUILD STEP, not one of the offline generators in the repo's
 * top-level tools/: its output lands in web/dist (never committed) and it must
 * re-run on every build, because each page is a copy of the freshly built
 * web/dist/index.html and therefore carries that build's hashed asset URLs.
 * web/package.json's `build` script runs it straight after `vite build`.
 *
 * That's also why it lives inside this workspace rather than in tools/. The
 * repo's .dockerignore drops the top-level tools/ and scripts/ directories —
 * they're offline tooling the image never needs — and those patterns are
 * anchored at the context root, so anything the Docker build actually has to
 * run must sit inside a workspace. A build step in tools/ typecheck-passes,
 * test-passes and builds fine locally, then fails only in the Docker job.
 *
 * WHY IT EXISTS. The glossary is ~125 curated bridge terms, each a page
 * someone might land on from a query like "what is a squeeze in bridge" — the
 * app's best long-tail search surface by a wide margin. App.tsx makes those
 * routes readable without an account, but the app is client-rendered: a
 * crawler that doesn't execute JavaScript (Bing, DuckDuckGo, most social
 * scrapers, most LLM crawlers) sees an empty <div id="root">. This emits real
 * HTML for them.
 *
 * The landing page (/) gets the same treatment for the same reason, and it is
 * why this file is no longer named prerender-glossary: the site's front door
 * is the URL most likely to be crawled, linked and unfurled, and it was the
 * one serving an empty #root to every agent that can't run JavaScript.
 *
 * WHAT IS NOT PRERENDERED, and deliberately: /leaderboard, /players/:id and
 * /tour are readable without an account now, but there is nothing durable to
 * put in the HTML — live personal records, or a board that only exists once
 * JavaScript runs. They carry `indexed: false` in server/src/seo.ts's route
 * table, which is what puts them behind a Disallow in robots.txt and keeps
 * them out of the sitemap; public and indexable are separate decisions.
 * If one of them ever earns a real static page: flip that flag and prerender
 * it here. The sitemap follows on its own, and the checks at the bottom of
 * this file fail the build if you do only one of the two.
 *
 * HOW. Each page is web/dist/index.html with exactly two substitutions:
 *   1. the <!-- seo:start --> … <!-- seo:end --> span in <head> is replaced
 *      with that page's title/description/canonical/OG/JSON-LD;
 *   2. <div id="root"></div> is filled with the page's content.
 * Everything else — the module script tag, the pre-paint theme script — is
 * copied verbatim, so a real visitor who follows a search result still boots
 * the ordinary SPA. React clears #root on mount, so the prerendered markup is
 * a fallback for non-JS agents and a first paint for everyone else, never a
 * second copy of the UI to keep in sync.
 *
 * Term data is imported straight from the TypeScript source. Node >= 24 (this
 * repo's engines floor, and what CI and the Dockerfile use) strips types
 * natively, so this needs no build of `web` and no bundler.
 *
 *   node scripts/prerender.mjs          # from web/, after `vite build`
 *
 * Also emits web/dist/sitemap.xml — from the pages this run actually wrote,
 * never a hand-kept list, and checked against server/src/seo.ts's route table
 * before it is written. See "the sitemap" at the bottom of this file.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** web/ — this file sits in web/scripts/, so one level up. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const outDir = join(dist, 'glossary-static');
/**
 * The landing page gets its OWN directory, not a file in glossary-static/.
 * server/src/app.ts builds its set of servable term pages by listing that
 * directory, so a home.html dropped in there would quietly also answer to
 * /glossary/home — a second URL for the front page, filed under the ledger.
 */
const homeDir = join(dist, 'home-static');

/** Production origin. Canonicals and the sitemap must point here from every
 *  deployment — the demo app and PR previews serve the same build, and are
 *  kept out of the index by server/src/app.ts's noindex block. */
const ORIGIN = 'https://bridge.brannon.online';

const { TERMS, THEME_CHIP } = await import(resolve(root, 'src/glossary/terms.ts'));
const deep = JSON.parse(readFileSync(resolve(root, 'src/glossary/deep.json'), 'utf8'));

/**
 * The site's route table, imported across the workspace boundary on purpose:
 * it is the same list the server derives robots.txt from, and a sitemap that
 * disagrees with robots.txt is the exact drift this arrangement exists to
 * make impossible. seo.ts is dependency-free and Node/DOM-free precisely so
 * this import costs nothing — same native type-stripping as terms.ts above.
 */
const { SITE_ROUTES, isDisallowed } = await import(resolve(root, '../server/src/seo.ts'));

/** Table semantics: `/x/*` covers everything under /x/, `/x` is exact. */
const covers = (routePath, pathname) =>
  routePath.endsWith('/*') ? pathname.startsWith(routePath.slice(0, -1)) : pathname === routePath;

/**
 * Every page this run wrote, in the order it wrote them. The sitemap is built
 * from this at the end, so "prerendered a page and forgot the sitemap" is not
 * a state this script can reach.
 */
const emitted = [];

/** Write a prerendered page and record its URL for the sitemap. */
function emit(pathname, file, html) {
  writeFileSync(file, html);
  emitted.push(pathname);
}

const shell = readFileSync(join(dist, 'index.html'), 'utf8');
const SEO_SPAN = /<!--\s*seo:start[\s\S]*?seo:end\s*-->/;
const ROOT_DIV = '<div id="root"></div>';
if (!SEO_SPAN.test(shell)) throw new Error('web/dist/index.html has no seo:start/seo:end span — did index.html change?');
if (!shell.includes(ROOT_DIV)) throw new Error(`web/dist/index.html has no ${ROOT_DIV} — did index.html change?`);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Serialize for embedding in a <script> element. HTML doesn't parse entities
 * inside a script, so esc() is the wrong tool here — but JSON.stringify leaves
 * `<` alone, which means a term whose text ever contained the literal
 * `</script>` would close the tag early and turn the rest of its definition
 * into markup. `<` is a valid JSON string escape, so parsers see exactly
 * the same value. Nothing in the curated terms trips this today; this is so
 * the next content edit can't quietly introduce it.
 */
const jsonForScript = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

/** Meta descriptions get truncated by search engines around 155 chars anyway. */
function clamp(s, max = 155) {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).replace(/[\s,;:.]+\S*$/, '')}…`;
}

const WIKI = 'https://en.wikipedia.org/wiki/Glossary_of_contract_bridge_terms';
const LICENSE = 'https://creativecommons.org/licenses/by-sa/4.0/';

/**
 * The CC BY-SA credit. Both terms.ts and deep.json are adaptations of
 * Wikipedia's bridge glossary, so this is a licence obligation on every
 * surface that reproduces the text — including these static ones, which a
 * reader may well see without the app's own Attribution component ever
 * rendering. Mirrors web/src/glossary/Attribution.tsx.
 */
const ATTRIBUTION =
  `<p class="pr-attrib">Adapted from Wikipedia’s <a href="${WIKI}"><i>Glossary of contract bridge terms</i></a> · ` +
  `<a href="${LICENSE}">CC BY-SA 4.0</a> — our adapted text is shared under the same license.</p>`;

/**
 * Self-contained styling for the prerendered markup. Deliberately NOT reusing
 * style.css's classes: this markup is a plain document, not the app's DOM, and
 * coupling it to app selectors would break it silently on any refactor. Brand
 * values are duplicated by hand — a handful of colours on a surface React
 * throws away the moment it mounts.
 */
const STYLE = `<style>
      .pr { max-width: 34rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; color: #141414;
            font-family: 'Crimson Pro', Georgia, serif; font-size: 1.05rem; line-height: 1.55; }
      .pr a { color: #141414; }
      .pr-crumbs, .pr-themes { font-size: .72rem; letter-spacing: .14em; text-transform: uppercase; color: #6E6A62; }
      .pr h1 { font-size: 2rem; margin: .6rem 0 .4rem; font-weight: 600; }
      .pr h2 { font-size: 1.05rem; letter-spacing: .1em; text-transform: uppercase; margin: 2rem 0 .5rem; }
      .pr-example { color: #6E6A62; font-style: italic; }
      .pr-aliases, .pr-attrib { font-size: .85rem; color: #6E6A62; }
      .pr-terms { list-style: none; padding: 0; }
      .pr-terms li { padding: .55rem 0; border-bottom: 1px solid #E4E1D8; }
      .pr-cta { margin-top: 2rem; font-weight: 600; }
      @media (prefers-color-scheme: dark) {
        .pr { color: #EDE9E1; } .pr a { color: #EDE9E1; }
        .pr-crumbs, .pr-themes, .pr-example, .pr-aliases, .pr-attrib { color: #9A948A; }
        .pr-terms li { border-bottom-color: #33302B; }
      }
      /* The media query alone isn't enough: index.html's pre-paint script sets
         data-theme from the stored nb:theme preference, so a visitor who chose
         Night on a light-OS machine would get a light flash on exactly the
         surface that paints first. Same both-places rule style.css follows for
         its own night tokens. */
      :root[data-theme='night'] .pr { color: #EDE9E1; }
      :root[data-theme='night'] .pr a { color: #EDE9E1; }
      :root[data-theme='night'] .pr-crumbs,
      :root[data-theme='night'] .pr-themes,
      :root[data-theme='night'] .pr-example,
      :root[data-theme='night'] .pr-aliases,
      :root[data-theme='night'] .pr-attrib { color: #9A948A; }
      :root[data-theme='night'] .pr-terms li { border-bottom-color: #33302B; }
      :root[data-theme='light'] .pr { color: #141414; }
      :root[data-theme='light'] .pr a { color: #141414; }
      :root[data-theme='light'] .pr-crumbs,
      :root[data-theme='light'] .pr-themes,
      :root[data-theme='light'] .pr-example,
      :root[data-theme='light'] .pr-aliases,
      :root[data-theme='light'] .pr-attrib { color: #6E6A62; }
      :root[data-theme='light'] .pr-terms li { border-bottom-color: #E4E1D8; }
    </style>`;

/** Swap the shell's site-wide SEO span and fill #root. */
function page({ head, body }) {
  return shell.replace(SEO_SPAN, head).replace(ROOT_DIV, `<div id="root">${body}</div>`);
}

/** The <head> span shared by every prerendered page. */
function head({ title, description, url, jsonLd }) {
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="Nickel Bridge" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${ORIGIN}/og-image.png" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${ORIGIN}/og-image.png" />`,
    `<script type="application/ld+json">${jsonForScript(jsonLd)}</script>`,
    STYLE,
  ].join('\n    ');
}

const TERM_SET = {
  '@type': 'DefinedTermSet',
  name: 'Nickel Bridge glossary of contract bridge terms',
  url: `${ORIGIN}/glossary`,
};

mkdirSync(outDir, { recursive: true });

// ---- one page per curated term ----
const bySlug = new Map(TERMS.map((t) => [t.slug, t]));
for (const t of TERMS) {
  const url = `${ORIGIN}/glossary/${t.slug}`;
  const title = `${t.term} — bridge term | Nickel Bridge`;
  const description = clamp(t.def);
  const related = (t.related ?? []).map((s) => bySlug.get(s)).filter(Boolean);

  const body = `<article class="pr">
      <p class="pr-crumbs"><a href="/">Nickel Bridge</a> › <a href="/glossary">Glossary</a></p>
      <h1>${esc(t.term)}</h1>
      <p class="pr-themes">${t.themes.map((th) => esc(THEME_CHIP[th])).join(' · ')}</p>
      <p>${esc(t.def)}</p>
      ${t.example ? `<p class="pr-example">${esc(t.example)}</p>` : ''}
      ${t.aliases?.length ? `<p class="pr-aliases">Also searched as: ${esc(t.aliases.join(', '))}</p>` : ''}
      ${
        related.length
          ? `<h2>Related</h2><p>${related
              .map((r) => `<a href="/glossary/${r.slug}">${esc(r.term)}</a>`)
              .join(' · ')}</p>`
          : ''
      }
      <p class="pr-cta"><a href="/">Play duplicate bridge at Nickel Bridge →</a></p>
      ${ATTRIBUTION}
    </article>`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'DefinedTerm',
        name: t.term,
        description: t.def,
        url,
        inDefinedTermSet: TERM_SET,
        ...(t.aliases?.length ? { alternateName: t.aliases } : {}),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Nickel Bridge', item: `${ORIGIN}/` },
          { '@type': 'ListItem', position: 2, name: 'Glossary', item: `${ORIGIN}/glossary` },
          { '@type': 'ListItem', position: 3, name: t.term },
        ],
      },
    ],
  };

  emit(
    `/glossary/${t.slug}`,
    join(outDir, `${t.slug}.html`),
    page({ head: head({ title, description, url, jsonLd }), body }),
  );
}

// ---- the glossary index ----
// Core terms only. The 784 deep-reference one-liners stay off the static pages
// on purpose: they're close paraphrases of Wikipedia's own glossary, so giving
// them indexable prose would be thin, duplicative content competing with the
// source we adapted them from. They remain in the app, behind the toggle.
const indexUrl = `${ORIGIN}/glossary`;
const indexTitle = `Glossary of bridge terms — ${TERMS.length} definitions | Nickel Bridge`;
const indexDesc = `A plain-language glossary of ${TERMS.length} contract bridge terms — bidding, card play, defense, scoring and SAYC conventions — each with an example.`;

const indexBody = `<article class="pr">
      <p class="pr-crumbs"><a href="/">Nickel Bridge</a> › Glossary</p>
      <h1>The Glossary</h1>
      <p>${esc(indexDesc)}</p>
      <ul class="pr-terms">
        ${TERMS.map(
          (t) =>
            `<li><a href="/glossary/${t.slug}"><strong>${esc(t.term)}</strong></a> — ${esc(clamp(t.def, 200))}</li>`,
        ).join('\n        ')}
      </ul>
      <p>A further ${deep.entries.length} entries are available in the app’s deep reference.</p>
      <p class="pr-cta"><a href="/">Play duplicate bridge at Nickel Bridge →</a></p>
      ${ATTRIBUTION}
    </article>`;

emit(
  '/glossary',
  join(outDir, 'index.html'),
  page({
    head: head({
      title: indexTitle,
      description: indexDesc,
      url: indexUrl,
      jsonLd: { '@context': 'https://schema.org', ...TERM_SET, description: indexDesc },
    }),
    body: indexBody,
  }),
);

// ---- the landing page ----
// A plain-prose version of pages/Login.tsx: the same five things it tells a
// visitor, in the order it tells them, minus everything that needs React (the
// specimen ledger, the graded-call panel, the ticket motifs). It must NOT try
// to reproduce the sign-in controls — which door a deployment offers is a
// /api/me answer the SPA resolves at runtime, and a statically rendered
// DEV_AUTH form would be a lie on production and an invitation on a preview.
// One CTA, pointing at the page itself, is the honest static fallback.
mkdirSync(homeDir, { recursive: true });

const homeTitle = 'Nickel Bridge — learn & play duplicate bridge';
const homeDesc =
  'Play duplicate bridge free in your browser — SAYC bidding with instant feedback on every call, matchpoint scoring, and a tournament always open.';

const homeBody = `<article class="pr">
      <h1>Nickel Bridge</h1>
      <p>${esc(homeDesc)}</p>
      <h2>A small club, completely free</h2>
      <p>Nickel Bridge is a club for learning bridge by playing it. You sit South, always. Your partner is
        a robot of even temper; your opponents, two more. The people you are truly playing came before you,
        and will come after — each one meeting your same cards at their own pace.</p>
      <h2>Everyone plays the same deals</h2>
      <p>Bad cards are no excuse here — everyone who crosses holds exactly what you held, whenever they
        get around to it. You are scored on what you did with the deal, against everyone who held it.
        That is duplicate bridge: the luck is dealt out of the game, and judgment is what is left.</p>
      <h2>Read the bid before you make it</h2>
      <p>Tap any call and the house tells you what it promises — the point range, the shape, whether it is
        conventional — before you commit to anything. The robots’ calls explain themselves the same way.
        And once you do commit, your bid is graded against the one the house would have chosen, in
        Standard American Yellow Card.</p>
      <h2>Boards are tickets. Playing is paying the toll.</h2>
      <p>Every board prints a receipt — the score itemized line by line, overtricks and insult and all —
        and then shows you what the rest of the field did with the same cards. Results are cancelled with a
        postmark, and the ledger of crossings keeps your running rating.</p>
      <h2>Before you sign anything</h2>
      <p>The ledger is open to anyone: a <a href="/glossary">glossary of ${TERMS.length} bridge terms</a> in
        plain language, no account needed. So is the practice board — walk one deal with the tollkeeper,
        bid it, play it, read the receipt. The tollkeeper keeps no record of practice boards.</p>
      <p class="pr-cta"><a href="/">Play duplicate bridge at Nickel Bridge →</a></p>
    </article>`;

emit(
  '/',
  join(homeDir, 'index.html'),
  page({
    head: head({
      title: homeTitle,
      description: homeDesc,
      url: `${ORIGIN}/`,
      // A self-canonical is safe here and nowhere else in the shell: this file
      // is served for exactly one URL (server/src/app.ts's GET /), whereas
      // web/index.html answers for every unprerendered route and deliberately
      // carries no canonical at all.
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'Nickel Bridge',
        url: `${ORIGIN}/`,
        applicationCategory: 'GameApplication',
        operatingSystem: 'Any (modern web browser)',
        description: homeDesc,
        image: `${ORIGIN}/og-image.png`,
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
    }).replace('og:type" content="article"', 'og:type" content="website"'),
    body: homeBody,
  }),
);

// ---- the sitemap ----
//
// Built from the pages this run wrote — not a list kept alongside them — and
// then checked, three ways, against server/src/seo.ts's route table. The
// checks throw, so a disagreement fails `npm run build` (and CI, and the
// Docker image) rather than shipping a sitemap that quietly lies:
//
//   1. nothing in the sitemap may be Disallow'd in robots.txt. That is a
//      contradiction a crawler reports back at you weeks later, and it is the
//      shape a well-meaning "make /leaderboard public" change takes.
//   2. nothing may be prerendered under a route the table doesn't mark
//      indexed — a page with no way in is either dead weight or a missing
//      table row.
//   3. every route the table DOES mark indexed must have produced at least
//      one page. Flipping `indexed: true` without prerendering anything is
//      how you promise a crawler a page and hand it the empty SPA shell.
//
// Sorted by the table's own order (front door, ledger index, then terms) so
// the file's shape follows the site's, and stays stable across builds.
const rank = (pathname) => {
  const i = SITE_ROUTES.findIndex((r) => covers(r.path, pathname));
  return i === -1 ? SITE_ROUTES.length : i;
};
const paths = [...emitted].sort((a, b) => rank(a) - rank(b));

const disallowed = paths.filter((p) => isDisallowed(p));
if (disallowed.length) {
  throw new Error(
    `prerendered pages are Disallow'd in robots.txt: ${disallowed.join(', ')} — ` +
      `flip the route to indexed: true in server/src/seo.ts, or stop prerendering it`,
  );
}
const unlisted = paths.filter((p) => !SITE_ROUTES.some((r) => r.indexed && covers(r.path, p)));
if (unlisted.length) {
  throw new Error(
    `prerendered pages match no indexed route in server/src/seo.ts: ${unlisted.join(', ')} — ` +
      `add the route to SITE_ROUTES with indexed: true`,
  );
}
const empty = SITE_ROUTES.filter((r) => r.indexed && !paths.some((p) => covers(r.path, p)));
if (empty.length) {
  throw new Error(
    `routes marked indexed in server/src/seo.ts but never prerendered: ${empty.map((r) => r.path).join(', ')} — ` +
      `prerender them here, or mark them indexed: false (which also Disallow's them in robots.txt)`,
  );
}

const urls = paths.map((p) => `${ORIGIN}${p}`);
writeFileSync(
  join(dist, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n') +
    `\n</urlset>\n`,
);

console.log(`prerendered ${TERMS.length} term pages + index → ${outDir}`);
console.log(`prerendered the landing page → ${join(homeDir, 'index.html')}`);
console.log(`sitemap: ${urls.length} urls → ${join(dist, 'sitemap.xml')}`);
