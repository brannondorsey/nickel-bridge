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
    // Pinned literally, not just cross-checked against whatever prerender.mjs
    // happens to also use: the two files can't share a real import (this is
    // raw, pre-module-graph HTML), so a consistent rename on BOTH sides would
    // otherwise sail through a check that only compares them to each other.
    // This is the one place the intended name is written down as a fact
    // rather than derived, so drifting it is a deliberate edit here too.
    expect(attr).toBe('data-returning-player');
    // .pr is the prerendered article's class; #root would stay hidden after
    // React refilled it. Both halves are pinned — a rule naming a class the
    // markup stopped using would pass a check on either one alone.
    expect(prerenderSrc).toContain(`:root[${attr}] .pr { display: none; }`);
  });

  it('suppresses it on the glossary pages too, which is a decision and not a shared constant', () => {
    // The rule lives in the one STYLE block all three templates embed, so it
    // covers the landing page, the ledger index AND every term page. That is
    // the intended scope (see the trade written out in index.html), but it is
    // the kind of scope that reads as an accident of sharing a constant — so
    // pin it here: giving one template its own markup class, or its own style
    // block, has to be a deliberate change rather than a quiet narrowing.
    expect(prerenderSrc.match(/<article class="pr">/g)).toHaveLength(3);
    expect(prerenderSrc.match(/const STYLE = `<style>/g)).toHaveLength(1);
  });
});
