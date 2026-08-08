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
    expect(pageTitle('/t/17/b/3/analyze', '')).toBe('Analyze board 3 · Crossing 17 | Nickel Bridge');
    // /t/:tid/review only ever redirects, but it should read as its crossing
    // while it does.
    expect(pageTitle('/t/17/review', '')).toBe('Crossing 17 | Nickel Bridge');
  });

  it('titles an unknown path as the gate refusing it', () => {
    expect(pageTitle('/nope', '')).toBe('Refused at the gate | Nickel Bridge');
    // Not a tournament — the id has to be a number for the route to mean one.
    expect(pageTitle('/t/abc', '')).toBe('Refused at the gate | Nickel Bridge');
  });

  it('matches the router on trailing slashes', () => {
    // react-router resolves /leaderboard/ to the /leaderboard route, so the
    // ladder renders. Before this was handled, the tab said "Refused at the
    // gate" over a perfectly good screen — and the analytics hit for that URL
    // looked like a 404 in the reports.
    expect(pageTitle('/leaderboard/', '')).toBe('Rankings | Nickel Bridge');
    expect(pageTitle('/glossary/', '')).toBe(pageTitle('/glossary', ''));
    expect(pageTitle('/t/17/b/3/', '')).toBe('Board 3 · Crossing 17 | Nickel Bridge');
    expect(pageTitle('/glossary/finesse/', '')).toBe('Finesse — bridge term | Nickel Bridge');
    // The root is one character long and must survive the trim.
    expect(pageTitle('/', '')).toBe(HOME_TITLE);
  });

  it('refuses the paths that render not-found, rather than naming their screen', () => {
    // These are looser than the <Route>s they resemble: /players/ with nothing
    // after it matches no route and renders the app's own not-found screen, so
    // titling it "Stats" would name a screen that isn't there.
    expect(pageTitle('/players/', '')).toBe('Refused at the gate | Nickel Bridge');
    expect(pageTitle('/compare/', '')).toBe('Refused at the gate | Nickel Bridge');
    expect(pageTitle('/t/17/nonsense', '')).toBe('Refused at the gate | Nickel Bridge');
    expect(pageTitle('/t/17/b/', '')).toBe('Refused at the gate | Nickel Bridge');
    expect(pageTitle('/players/42/extra', '')).toBe('Refused at the gate | Nickel Bridge');
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

    it('titles an unknown term PATH as the glossary, which is where it lands', () => {
      // Glossary.tsx replaces /glossary/<slug> with /glossary?term=<slug> on
      // mount, and an unknown ?term= falls through to the index — so the
      // visitor ends on the glossary with a "not in the ledger" sheet. Saying
      // "Refused at the gate" here would be a flash of the wrong answer.
      expect(pageTitle('/glossary/not-a-term', '')).toBe(
        `Glossary of bridge terms — ${TERMS.length} definitions | Nickel Bridge`,
      );
    });
  });

  it('pins the home title, the string three places have to agree on', () => {
    // prerender.mjs derives its copy from HOME_TITLE, so it cannot drift; the
    // test below covers index.html, which can. This is the speed bump for
    // changing the string itself.
    expect(HOME_TITLE).toBe('Nickel Bridge — learn & play duplicate bridge');
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
