/**
 * The home-screen icon set, held together across the three files that have to
 * agree about it.
 *
 * web/public/site.webmanifest NAMES the icons for Android, web/index.html
 * LINKS the manifest plus the one file the manifest can't carry (iOS reads
 * apple-touch-icon from a <link> and ignores the manifest), and
 * scripts/app-icons.mjs DRAWS whatever those two declare — it reads them
 * rather than keeping its own list, so a size added to the manifest gets
 * generated on the next run.
 *
 * What that leaves unchecked is the direction the generator can't police:
 * whether the PNGs it would draw are actually CHECKED IN. Nothing in the
 * build runs it — the outputs are committed assets, like og-image.png — so a
 * manifest entry whose file was never generated (or was renamed, or dropped
 * in a rebase) is a 404 the launcher answers by silently falling back to the
 * favicon, i.e. straight back to the letterboxed tile this whole change
 * exists to fix, with nothing red anywhere. That is what this file is for.
 *
 * Vite's ?raw and import.meta.glob rather than node:fs, matching
 * prepaint.test.ts — this workspace deliberately has no @types/node.
 */
import { describe, expect, it } from 'vitest';
import shellHtml from '../index.html?raw';
import manifestJson from '../public/site.webmanifest?raw';

const manifest: {
  icons: { src: string; sizes: string; type: string; purpose: string }[];
  theme_color: string;
  background_color: string;
  scope: string;
  start_url: string;
  display: string;
} = JSON.parse(manifestJson);

/** Every PNG actually checked in, by filename. */
const shipped = new Set(
  Object.keys(import.meta.glob('../public/*.png')).map((p) => p.split('/').pop()!),
);

describe('home-screen icons', () => {
  it('ships a PNG for every icon the manifest names', () => {
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    for (const icon of manifest.icons) {
      expect(icon.src, 'manifest icon srcs are root-absolute').toMatch(/^\/[^/]+\.png$/);
      expect(shipped, `${icon.src} is declared but was never generated`).toContain(icon.src.slice(1));
    }
  });

  it('declares a square, single size the generator can draw', () => {
    // app-icons.mjs refuses anything it would have to guess at, so a bad
    // `sizes` fails the NEXT run of a script nobody runs on a schedule. Catch
    // it here instead, where it fails on the commit that introduced it.
    for (const icon of manifest.icons) expect(icon.sizes, icon.src).toMatch(/^(\d+)x\1$/);
  });

  it('offers both an "any" and a "maskable" tile at each size', () => {
    // The two purposes are drawn from different artworks — maskable pulls the
    // mark inside Android's 80% crop circle. Ship only "any" and Android
    // either crops the piers off the mark or shrinks the whole tile onto a
    // white background of its own; ship only "maskable" and every unmasked
    // surface shows a mark floating in too much paper.
    const bySize = new Map<string, Set<string>>();
    for (const icon of manifest.icons) {
      if (!bySize.has(icon.sizes)) bySize.set(icon.sizes, new Set());
      bySize.get(icon.sizes)!.add(icon.purpose);
    }
    for (const [size, purposes] of bySize) expect([...purposes].sort(), size).toEqual(['any', 'maskable']);
  });

  it('links the manifest and the icon the manifest cannot carry', () => {
    expect(shellHtml).toContain('<link rel="manifest" href="/site.webmanifest" />');

    // The apple-touch-icon link is the ONLY declaration of that file — it is
    // deliberately absent from the manifest, which iOS does not read for it —
    // so the generator parses this tag, `sizes` included, to know what to
    // draw. Both attributes are load-bearing, not decoration.
    const tag = /<link[^>]*rel="apple-touch-icon"[^>]*>/.exec(shellHtml)?.[0];
    expect(tag, 'no <link rel="apple-touch-icon"> — iOS would screenshot the page instead').toBeTruthy();
    expect(tag).toMatch(/sizes="(\d+)x\1"/);
    const href = /href="\/([^"]+)"/.exec(tag!)?.[1];
    expect(shipped, `${href} is linked but was never generated`).toContain(href!);
    expect(manifest.icons.map((i) => i.src)).not.toContain(`/${href}`);
  });

  it('keeps the icon block out of the swapped-per-page SEO span', () => {
    // prerender.mjs replaces everything between the seo markers wholesale, so
    // an icon link that drifted inside them would silently vanish from all
    // ~126 prerendered pages while staying correct on the SPA shell.
    const head = shellHtml.slice(0, shellHtml.indexOf('seo:start'));
    expect(head).toContain('rel="manifest"');
    expect(head).toContain('rel="apple-touch-icon"');
  });

  it('agrees with the shell about the brand colours', () => {
    // theme_color disagreeing with the meta tag is a real, visible split: the
    // meta paints the browser chrome and the manifest paints the standalone
    // window and the launch screen behind it.
    expect(shellHtml).toContain(`<meta name="theme-color" content="${manifest.theme_color}" />`);
    expect(manifest.background_color).toBe(manifest.theme_color);
  });

  it('scopes the standalone window to the whole app', () => {
    // start_url outside scope, or a scope narrower than the router, drops the
    // player back into a browser tab the first time they navigate.
    expect(manifest.scope).toBe('/');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
  });
});
