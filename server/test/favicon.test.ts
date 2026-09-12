/**
 * The tab favicon's two hard-coded colours, held against the tokens they are
 * copies of.
 *
 * A favicon is fetched outside the document, so its SVG can read neither
 * `[data-theme]` nor `--verdigris` — it has to carry both colours as literals.
 * That is the same constraint the splash river scene lives with (two files,
 * CSS-swapped by theme; see the `.splash-bridge` note in web/src/style.css),
 * except the river scene fails visibly on a screen somebody is looking at,
 * while a stale favicon is a 16px mark on a tab nobody inspects. So a
 * style.css token edit that leaves the tab behind should fail a test.
 *
 * It lives in the SERVER workspace rather than beside web/src/appIcons.test.ts
 * for a dull but load-bearing reason: web's vitest config sets `css: false`, so
 * `import '...style.css?raw'` there resolves to an EMPTY STRING and every
 * assertion built on it passes vacuously. This workspace has @types/node and
 * can just read the file. The server also serves both files, so it is not a
 * stranger to them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const favicon = readFileSync(resolve(root, 'web/public/favicon.svg'), 'utf8');
const css = readFileSync(resolve(root, 'web/src/style.css'), 'utf8');

/** A custom property's value inside the CSS block a selector opens. */
function token(selector: string, name: string): string {
  const at = css.indexOf(selector);
  expect(at, `style.css no longer has a ${selector} block`).toBeGreaterThan(-1);
  const found = new RegExp(`${name}:\\s*(#[0-9a-f]{3,8})`, 'i').exec(css.slice(at, at + 2000));
  expect(found, `${selector} declares no ${name}`).not.toBeNull();
  return found![1].toLowerCase();
}

const lightStroke = /g\s*\{\s*stroke:\s*(#[0-9a-f]{6})/i.exec(favicon)?.[1]?.toLowerCase();
const darkStroke = /prefers-color-scheme:\s*dark\)\s*\{[^}]*stroke:\s*(#[0-9a-f]{6})/i
  .exec(favicon)?.[1]
  ?.toLowerCase();

describe('favicon dark mode', () => {
  it('parsed both strokes out of the file at all', () => {
    // Guards the two regexes above rather than the colours: reformat the SVG
    // and every comparison below would otherwise pass by comparing undefined
    // to undefined.
    expect(lightStroke, 'no day stroke found — did the <style> block change shape?').toBeTruthy();
    expect(darkStroke, 'no dark-mode stroke found').toBeTruthy();
    expect(lightStroke).not.toBe(darkStroke);
  });

  it('recolours on the OS preference rather than assuming one', () => {
    expect(favicon).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
  });

  it('draws the day mark in the brand verdigris', () => {
    expect(lightStroke).toBe(token(':root {', '--verdigris'));
  });

  it('draws the night mark in the night ink', () => {
    // Deliberately --ink and not the night --verdigris. Both are defensible —
    // the mark is verdigris everywhere else at night — and the owner chose the
    // off-white treatment for the tab, where the icon is 16px and contrast is
    // worth more than hue. Swapping is one literal in the SVG plus this line,
    // which is where the decision is recorded.
    expect(darkStroke).toBe(token("[data-theme='night'] {", '--ink'));
  });

  it('stays transparent linework — no background rect', () => {
    // A charcoal tile is the obvious thing to reach for and it does not work
    // here: a rect fills the 160x122 canvas, not the square box a browser fits
    // the icon into, so it paints a letterboxed bar. Squaring the canvas to
    // allow one would shrink the mark in light mode too. The home-screen PNGs
    // are where a filled tile belongs.
    expect(favicon).not.toMatch(/<rect/);
  });
});
