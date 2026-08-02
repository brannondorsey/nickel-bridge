/**
 * The pre-paint inline scripts in web/index.html, held against the code that
 * depends on them.
 *
 * Those scripts are plain, blocking JS duplicated by hand — they have to run
 * before the module graph loads, so they can't import anything. Nothing else in
 * the build would notice if a key were renamed on one side only, and every
 * failure mode here is invisible in tests and obvious to a user: a light flash
 * on a night-mode machine, the wrong suit colours for a colourblind player, or
 * the landing-page pitch flashing over the lobby on every refresh.
 *
 * Vite's ?raw import rather than node:fs, matching pageTitle.test.ts — this
 * workspace deliberately has no @types/node.
 */
import { describe, expect, it } from 'vitest';
import shellHtml from '../index.html?raw';
import prerenderSrc from '../scripts/prerender.mjs?raw';
import { LAST_VISIT_KEY } from './splash';
import { SUIT_PALETTE_KEY } from './suitPalette';
import { THEME_KEY } from './theme';

describe('pre-paint scripts', () => {
  it('reads the same storage keys the app writes', () => {
    for (const key of [THEME_KEY, SUIT_PALETTE_KEY, LAST_VISIT_KEY]) {
      expect(shellHtml).toContain(`localStorage.getItem('${key}')`);
    }
  });

  it('suppresses the prerendered fallback for a browser that has signed in', () => {
    // The two halves of the no-flash fix: index.html marks the document from
    // the nb:lastVisit stamp, prerender.mjs's <style> hides its own markup
    // under that mark. Neither does anything alone, and the attribute name is
    // the only thing joining them.
    const marked = shellHtml.match(
      new RegExp(`localStorage\\.getItem\\('${LAST_VISIT_KEY}'\\)[\\s\\S]{0,200}?setAttribute\\('([a-z-]+)'`),
    );
    expect(marked, 'index.html no longer marks the document from nb:lastVisit').not.toBeNull();

    const attr = marked![1];
    // .pr is the prerendered article's class; #root would stay hidden after
    // React refilled it. Both halves are pinned — a rule naming a class the
    // markup stopped using would pass a check on either one alone.
    expect(prerenderSrc).toContain(`:root[${attr}] .pr { display: none; }`);
    expect(prerenderSrc.match(/<article class="pr">/g)?.length).toBe(3);
  });
});
