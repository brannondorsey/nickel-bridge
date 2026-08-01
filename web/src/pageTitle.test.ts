import { describe, expect, it } from 'vitest';
// Vite's ?raw import, not node:fs — this workspace deliberately has no
// @types/node (see server/src/seo.ts's note), and it keeps the file read
// inside the same resolver the app itself is built with.
import shellHtml from '../index.html?raw';
import { TERMS } from './glossary/terms';
import { HOME_TITLE, pageTitle } from './pageTitle';

describe('pageTitle', () => {
  it('gives the front door its pitch, not a screen name', () => {
    expect(pageTitle('/', '')).toBe(HOME_TITLE);
  });

  it('names each screen the way the tab bar does', () => {
    expect(pageTitle('/leaderboard', '')).toBe('Rankings | Nickel Bridge');
    expect(pageTitle('/activity', '')).toBe('Traffic | Nickel Bridge');
    expect(pageTitle('/settings', '')).toBe('Settings | Nickel Bridge');
    expect(pageTitle('/players/42', '')).toBe('Stats | Nickel Bridge');
    expect(pageTitle('/compare/42', '')).toBe('Head to head | Nickel Bridge');
    expect(pageTitle('/tour', '')).toBe('The first crossing | Nickel Bridge');
    expect(pageTitle('/scenarios', '')).toBe('The Exhibit Hall | Nickel Bridge');
  });

  it('numbers crossings and boards, so two open tabs are tellable apart', () => {
    expect(pageTitle('/t/17', '')).toBe('Crossing 17 | Nickel Bridge');
    expect(pageTitle('/t/17/b/3', '')).toBe('Board 3 · Crossing 17 | Nickel Bridge');
    // /t/:tid/review only ever redirects, but it should read as its crossing
    // while it does.
    expect(pageTitle('/t/17/review', '')).toBe('Crossing 17 | Nickel Bridge');
  });

  it('titles an unknown path as the gate refusing it', () => {
    expect(pageTitle('/nope', '')).toBe('Refused at the gate | Nickel Bridge');
    // Not a tournament — the id has to be a number for the route to mean one.
    expect(pageTitle('/t/abc', '')).toBe('Refused at the gate | Nickel Bridge');
  });

  describe('the glossary, whose titles the prerender emits from this function', () => {
    // Spelled out as literals on purpose: web/scripts/prerender.mjs calls
    // pageTitle() for every page it writes, so the two can't disagree — but
    // that also means an edit to a format here silently rewrites 127 static
    // pages' <title> and OG tags. These assertions are the speed bump.
    const term = TERMS.find((t) => t.slug === 'finesse') ?? TERMS[0];

    it('titles the index with the count', () => {
      expect(pageTitle('/glossary', '')).toBe(
        `Glossary of bridge terms — ${TERMS.length} definitions | Nickel Bridge`,
      );
    });

    it('titles a term page', () => {
      expect(pageTitle(`/glossary/${term.slug}`, '')).toBe(`${term.term} — bridge term | Nickel Bridge`);
    });

    it('follows the term sheet wherever it is opened from', () => {
      // The sheet is a ?term= param on whatever route you are reading, and
      // analytics.ts already counts it as its own URL — the tab should agree.
      expect(pageTitle('/glossary', `?term=${term.slug}`)).toBe(`${term.term} — bridge term | Nickel Bridge`);
      expect(pageTitle('/t/17/b/3', `?term=${term.slug}`)).toBe(`${term.term} — bridge term | Nickel Bridge`);
    });

    it('falls back to the route for an unknown ?term=, as the server does', () => {
      expect(pageTitle('/glossary', '?term=not-a-term')).toBe(
        `Glossary of bridge terms — ${TERMS.length} definitions | Nickel Bridge`,
      );
      expect(pageTitle('/leaderboard', '?term=not-a-term')).toBe('Rankings | Nickel Bridge');
    });

    it('refuses an unknown term PATH, which the server answers 404 for', () => {
      expect(pageTitle('/glossary/not-a-term', '')).toBe('Refused at the gate | Nickel Bridge');
    });

    it('agrees with the prerender about the home title', () => {
      expect(HOME_TITLE).toBe('Nickel Bridge — learn & play duplicate bridge');
    });
  });

  it("matches web/index.html's shell title, the one copy that can't be derived", () => {
    // Every unprerendered route is served that shell, so its <title> is what a
    // visitor sees until React mounts. prerender.mjs imports pageTitle() and so
    // can never disagree; a raw HTML file has no module graph, so this is the
    // one place a stale title could survive — hence a real read rather than a
    // literal restated in a test.
    const title = shellHtml
      .match(/<title>([\s\S]*?)<\/title>/)![1]
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    expect(title).toBe(HOME_TITLE);
  });
});
