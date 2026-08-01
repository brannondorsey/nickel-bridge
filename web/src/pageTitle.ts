/**
 * What the browser tab says, per route.
 *
 * The app is client-rendered from one shell, so until now every screen wore
 * web/index.html's site-wide title: a visitor with three tabs open — a board,
 * someone's profile, a glossary term — saw "Nickel Bridge — learn & play
 * duplicate bridge" three times, and so did their history and every bookmark
 * they made. The prerendered pages (web/scripts/prerender.mjs) were the one
 * exception, and only until React mounted over them.
 *
 * It also fixes a reporting hole: analytics.ts sends `page_title` with every
 * view, which meant GA recorded the ENTRY page's title for every screen of a
 * visit. The path dimension was fine; the title one was noise.
 *
 * TWO RULES THIS FOLLOWS.
 *
 * 1. The app's own vocabulary, not invented copy. A tab reading "Rankings" or
 *    "Traffic" matches the tab bar the visitor tapped to get there; the
 *    ledger's terms (crossing, board, the first crossing, the Exhibit Hall)
 *    are the ones the screens themselves use. What it does NOT do is copy the
 *    tracked-caps LOOK of those labels — `RANKINGS` is a Besley treatment in
 *    the design system, and a tab title has no typography, so caps there just
 *    reads as shouting. Same reason the brand's period flavour stays out of
 *    functional copy: "Refused at the gate" is the 404's own words, in
 *    sentence case.
 *
 * 2. It must agree with the prerender, byte for byte. A shared link to
 *    /glossary/finesse is served a static page whose <title> is already
 *    correct; if this function produced anything different, the tab would
 *    visibly rewrite itself the moment the SPA booted. So it isn't kept in
 *    agreement — web/scripts/prerender.mjs imports THIS function and titles
 *    every page it emits with it. The one copy that can't be derived is
 *    web/index.html's shell <title>, which has to be literal text in a file
 *    with no module graph; pageTitle.test.ts pins HOME_TITLE's exact string
 *    so an edit there fails a test rather than drifting quietly.
 *
 * Kept Node-importable for that reason: no DOM, no React, no imports beyond
 * the glossary data — and that one carries its .ts extension, because the
 * prerender runs under bare Node, whose resolver won't guess it. See the note
 * in web/tsconfig.json.
 */
import { TERMS } from './glossary/terms.ts';

/** The one title with no screen name in it: the front door's own pitch. */
export const HOME_TITLE = 'Nickel Bridge — learn & play duplicate bridge';

const SITE = 'Nickel Bridge';

/** `<what you are looking at> | Nickel Bridge`, the shape every other page takes. */
const titled = (what: string) => `${what} | ${SITE}`;

const termBySlug = new Map(TERMS.map((t) => [t.slug, t]));

/**
 * The title for a URL. Pure and synchronous — it reads the path, the `?term=`
 * param and the static glossary data, and nothing else.
 *
 * Screens that know more than the URL does (a player's handle, a tournament's
 * date) can refine this later by setting document.title themselves once their
 * data arrives; App.tsx applies this on every navigation, so a page-level
 * refinement is a last-write-wins override that resets when you navigate away.
 */
export function pageTitle(pathname: string, search: string): string {
  // A term sheet is the foreground content wherever it is opened from, and
  // analytics.ts already counts it as its own URL — so the title follows the
  // sheet rather than the page underneath it. An unknown slug falls through
  // to the route's own title, exactly as the server treats an unknown
  // ?term= (a 200 on the index, never an error).
  const slug = new URLSearchParams(search).get('term');
  const sheet = slug ? termBySlug.get(slug) : undefined;
  if (sheet) return titled(`${sheet.term} — bridge term`);

  if (pathname === '/') return HOME_TITLE;
  if (pathname === '/glossary') return titled(`Glossary of bridge terms — ${TERMS.length} definitions`);
  if (pathname.startsWith('/glossary/')) {
    const term = termBySlug.get(pathname.slice('/glossary/'.length));
    // Not in the ledger: the app shows its own "no such term" sheet on a path
    // the server answered 404 for, so the title should say so too.
    return term ? titled(`${term.term} — bridge term`) : titled('Refused at the gate');
  }

  if (pathname === '/leaderboard') return titled('Rankings');
  if (pathname === '/activity') return titled('Traffic');
  if (pathname === '/settings') return titled('Settings');
  if (pathname === '/tour') return titled('The first crossing');
  if (pathname === '/scenarios') return titled('The Exhibit Hall');
  if (pathname.startsWith('/players/')) return titled('Stats');
  if (pathname.startsWith('/compare/')) return titled('Head to head');

  // A crossing, and the board within it. Both numbers come from the URL, which
  // is what makes two open boards tellable apart in a tab strip or a history
  // list — the whole point of the exercise.
  const board = pathname.match(/^\/t\/(\d+)\/b\/(\d+)$/);
  if (board) return titled(`Board ${board[2]} · Crossing ${board[1]}`);
  const crossing = pathname.match(/^\/t\/(\d+)(\/|$)/);
  if (crossing) return titled(`Crossing ${crossing[1]}`);

  return titled('Refused at the gate');
}
