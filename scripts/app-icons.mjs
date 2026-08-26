/**
 * The home-screen icon set: web/public/icon-*.png + apple-touch-icon.png.
 *
 * WHAT WAS WRONG. The shell declared exactly one icon — `/favicon.svg`, the
 * BridgeMark glyph on a 160×122 viewBox with no background and the artwork
 * running edge to edge. That file is right for a browser tab and wrong for
 * every home-screen surface, in three separate ways:
 *
 *   - It is NOT SQUARE. Android and iOS both want a square tile, so a 4:3
 *     drawing gets letterboxed — which is the "improperly centered" report:
 *     the deck line lands hard against the top of the tile while a band of
 *     dead space sits under the arch.
 *   - It has NO SAFE ZONE. The deck line spans x=0..160 and the piers sit on
 *     the outer edges, so any mask with a radius — Android's adaptive-icon
 *     circle/squircle, iOS's superellipse — cuts straight through the mark.
 *   - It is rasterised at whatever size the launcher happens to want, from a
 *     file the launcher was never offered at that size. Hence "too low res":
 *     nothing here is actually low resolution, it is a downscale nobody
 *     art-directed.
 *
 * So this script draws the mark onto a square paper tile with real margins,
 * at the sizes the platforms ask for, and a manifest (web/public/
 * site.webmanifest) hands them over by name. The favicon stays exactly as it
 * is — it is still the correct thing for a tab.
 *
 * TWO ARTWORKS, because the two manifest purposes crop differently:
 *
 *   - "any": the full square is shown. Used for the tab-adjacent surfaces, the
 *     standalone splash and the task switcher, and — because iOS applies its
 *     own corner rounding and no inset — for apple-touch-icon too.
 *   - "maskable": Android may crop to a circle of 80% of the width, so
 *     everything that must survive has to sit inside that circle. For a mark
 *     this wide that is a tighter bound than it looks: a centred w×h box fits
 *     when hypot(w, h) <= 0.8·S, and at the glyph's 160:122 that caps the
 *     width at ~0.636·S. MARK_MASKABLE is under it with room to spare, and the
 *     paper bleeds to all four edges so a crop never exposes a bare corner.
 *
 * Rendered offline with Playwright and checked in, the same shape as
 * scripts/og-image.mjs: nothing at build or request time depends on this, so
 * an ordinary `npm run build` never needs a browser. Re-run it only when the
 * bridge mark or the brand paper/verdigris tokens change:
 *
 *   node scripts/app-icons.mjs            # → web/public/
 *   node scripts/app-icons.mjs /tmp/out   # somewhere else
 *
 * THE MANIFEST IS THE TABLE, and this script reads it rather than keeping a
 * second list beside it — the same move server/src/seo.ts makes for robots.txt
 * and the sitemap. web/public/site.webmanifest already has to name every icon,
 * its size and its purpose for Android's benefit, so a hand-kept list here
 * would be a copy that drifts silently: a manifest entry the generator forgot
 * is a 404 the launcher answers by falling back to the favicon, i.e. straight
 * back to the letterboxed tile. Add a size to the manifest and it gets drawn.
 *
 * The one file the manifest cannot carry is apple-touch-icon.png — iOS reads
 * that from a <link> in the shell and ignores the manifest — so it is
 * discovered from web/index.html's own link tag, `sizes` attribute included,
 * rather than hardcoded here.
 *
 * web/src/appIcons.test.ts is the drift guard on the other side: it holds the
 * manifest and that link against the PNGs actually checked in.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = process.argv[2] ?? resolve(root, 'web/public');

/**
 * Brand tokens, spelled out rather than imported: this runs under bare Node
 * with no bundler, and web/src/style.css is not a module. Keep in sync with
 * --paper and --verdigris there (and with .claude/skills/nickel-bridge-design).
 */
const PAPER = '#FCFBF8';
const VERDIGRIS = '#6F8F68';

/** Mark width as a fraction of the tile, per purpose. See the doc comment. */
const MARK_ANY = 0.7;
const MARK_MASKABLE = 0.58;

/** The glyph's own aspect, from BridgeMark's viewBox — 160 wide by 122 tall. */
const GLYPH_W = 160;
const GLYPH_H = 122;

/**
 * The bridge glyph, kept in sync with web/src/components/ds/BridgeMark.tsx
 * (variant="glyph") and web/public/favicon.svg. Same copy-rather-than-import
 * reason as og-image.mjs's footer mark.
 */
const GLYPH = `
  <g stroke="${VERDIGRIS}" fill="none">
    <line x1="0" y1="10" x2="160" y2="10" stroke-width="14" />
    <path d="M8 112 Q80 38 152 112" stroke-width="10" />
    <line x1="8" y1="10" x2="8" y2="112" stroke-width="10" />
    <line x1="152" y1="10" x2="152" y2="112" stroke-width="10" />
    <line x1="80" y1="10" x2="80" y2="75" stroke-width="7" />
  </g>`;

/**
 * One tile as an SVG string. The glyph is placed as a nested <svg> so it
 * scales as a unit and centres on the tile's own middle — the ink runs
 * y=3..117 of the 122-unit box, i.e. one unit above centre, which is under a
 * percent and not worth correcting for.
 */
function tile(size, fraction) {
  const w = size * fraction;
  const h = (w * GLYPH_H) / GLYPH_W;
  const x = (size - w) / 2;
  const y = (size - h) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${PAPER}" />
  <svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${GLYPH_W} ${GLYPH_H}">${GLYPH}</svg>
</svg>`;
}

/**
 * Every icon the manifest names, as {file, size, purpose}. `sizes` is a
 * space-separated list in general; these are all single square entries, and a
 * non-square or multi-size value is refused rather than guessed at.
 */
function manifestIcons() {
  const manifest = JSON.parse(readFileSync(resolve(root, 'web/public/site.webmanifest'), 'utf8'));
  return (manifest.icons ?? []).map((icon) => {
    const m = /^(\d+)x\1$/.exec(icon.sizes ?? '');
    if (!m) throw new Error(`site.webmanifest: icon ${icon.src} needs a single square "sizes", got "${icon.sizes}"`);
    return { file: icon.src.replace(/^\//, ''), size: Number(m[1]), purpose: icon.purpose ?? 'any' };
  });
}

/**
 * The apple-touch-icon, read off the shell's own <link>. iOS ignores the
 * manifest for this, so the link tag is the only place it is declared and
 * therefore the only honest place to read it from.
 */
function appleTouchIcon() {
  const html = readFileSync(resolve(root, 'web/index.html'), 'utf8');
  const tag = /<link[^>]*rel="apple-touch-icon"[^>]*>/.exec(html)?.[0];
  if (!tag) throw new Error('web/index.html has no <link rel="apple-touch-icon">');
  const href = /href="\/([^"]+)"/.exec(tag)?.[1];
  const size = /sizes="(\d+)x\1"/.exec(tag)?.[1];
  if (!href || !size) throw new Error(`apple-touch-icon link needs an absolute href and a square sizes: ${tag}`);
  return { file: href, size: Number(size), purpose: 'any' };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  // Same launch line as og-image.mjs / ui-check.mjs / readme-shots.mjs.
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  try {
    for (const { file, size, purpose } of [...manifestIcons(), appleTouchIcon()]) {
      const svg = tile(size, purpose === 'maskable' ? MARK_MASKABLE : MARK_ANY);
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      await page.setContent(`<!doctype html><style>html,body{margin:0;padding:0}</style>${svg}`);
      const png = await page.screenshot({ type: 'png' });
      await page.close();
      const path = resolve(outDir, file);
      writeFileSync(path, png);
      console.log(`${file}  ${size}×${size}  ${purpose}  ${png.length.toLocaleString()} bytes`);
    }
  } finally {
    await browser.close();
  }
}

// Importable by the drift guard without launching a browser.
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
