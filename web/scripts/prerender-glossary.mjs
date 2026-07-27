/**
 * Prerender the glossary to static HTML — the crawlable half of the app.
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
 * HOW. Each page is web/dist/index.html with exactly two substitutions:
 *   1. the <!-- seo:start --> … <!-- seo:end --> span in <head> is replaced
 *      with that page's title/description/canonical/OG/JSON-LD;
 *   2. <div id="root"></div> is filled with the term's content.
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
 *   node scripts/prerender-glossary.mjs          # from web/, after `vite build`
 *
 * Also emits web/dist/sitemap.xml, so the URL list has exactly one source.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** web/ — this file sits in web/scripts/, so one level up. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const outDir = join(dist, 'glossary-static');

/** Production origin. Canonicals and the sitemap must point here from every
 *  deployment — the demo app and PR previews serve the same build, and are
 *  kept out of the index by server/src/app.ts's noindex block. */
const ORIGIN = 'https://bridge.brannon.online';

const { TERMS, THEME_CHIP } = await import(resolve(root, 'src/glossary/terms.ts'));
const deep = JSON.parse(readFileSync(resolve(root, 'src/glossary/deep.json'), 'utf8'));

const shell = readFileSync(join(dist, 'index.html'), 'utf8');
const SEO_SPAN = /<!--\s*seo:start[\s\S]*?seo:end\s*-->/;
const ROOT_DIV = '<div id="root"></div>';
if (!SEO_SPAN.test(shell)) throw new Error('web/dist/index.html has no seo:start/seo:end span — did index.html change?');
if (!shell.includes(ROOT_DIV)) throw new Error(`web/dist/index.html has no ${ROOT_DIV} — did index.html change?`);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
    `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
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

  writeFileSync(join(outDir, `${t.slug}.html`), page({ head: head({ title, description, url, jsonLd }), body }));
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

writeFileSync(
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

// ---- sitemap ----
const urls = [`${ORIGIN}/`, indexUrl, ...TERMS.map((t) => `${ORIGIN}/glossary/${t.slug}`)];
writeFileSync(
  join(dist, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n') +
    `\n</urlset>\n`,
);

console.log(`prerendered ${TERMS.length} term pages + index → ${outDir}`);
console.log(`sitemap: ${urls.length} urls → ${join(dist, 'sitemap.xml')}`);
