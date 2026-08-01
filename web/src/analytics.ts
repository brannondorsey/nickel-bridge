/**
 * Analytics — a self-hosted Matomo, and nothing else.
 *
 * The app has never had any measurement at all: the only signal about whether
 * anyone reads the glossary, finishes the tour, or bounces off the landing
 * page was the request log, which answers "who woke the machine" (see
 * server/src/logging.ts) and not much more. This is the smallest thing that
 * answers the product questions instead.
 *
 * WHY SELF-HOSTED. The obvious alternative is Google Analytics, which would
 * hand a third party a per-visitor record of a site whose whole public surface
 * is other people's handles, ratings and reading habits — in exchange for
 * numbers we can already compute ourselves. Matomo runs on our own box
 * (piwik.brannon.online), so the data never leaves infrastructure this project
 * already operates, and there is no ad-network identity graph on the other end
 * of it. Two consequences worth knowing rather than rediscovering:
 *
 *   - It costs the Fly machine nothing. matomo.js and matomo.php are served by
 *     a different host entirely, so none of this shows up as a request that
 *     wakes or holds the app's dedicated core (see CLAUDE.md, "Machine time is
 *     bought by the request"). It is also outside the Cloudflare rules derived
 *     from seo.ts, for the same reason: different hostname, different origin.
 *   - Cookies are OFF (`disableCookies`). Matomo falls back to a 24-hour
 *     config-id heuristic, so unique-visitor counts get fuzzier and returning
 *     visitors across days are undercounted — the trade is that the site keeps
 *     needing no cookie banner, which is the honest position for an app whose
 *     only other cookie is the session it can't work without. `setDoNotTrack`
 *     is the same bargain: a browser that asks not to be counted isn't.
 *
 * WHY NOT THE STOCK <script> SNIPPET. Matomo's copy-paste snippet fires one
 * `trackPageView` on load, which for a client-rendered SPA means every visit
 * is recorded as a single hit on whatever URL the visitor entered on, and the
 * glossary term they went on to read, the tour they walked and the boards they
 * played are all invisible. Route changes have to be tracked explicitly, which
 * is what `useAnalytics` below does from App.tsx's router state.
 *
 * WHERE IT IS DISABLED, and why the check is a round trip rather than a
 * hostname: the demo app and every PR preview serve a byte-identical bundle
 * from their own hostnames, and their traffic is bots, seeders and
 * click-testing — exactly the same reason seo.ts's `throwaway` flag shuts
 * crawlers out of them. `/api/me` already reports `demo`/`devAuth` and App.tsx
 * already fetches it before rendering anything, so that flag is reused here
 * instead of pinning a production hostname into the bundle. Local development
 * is excluded by hostname on top of that, since a locally built server with
 * neither flag set would otherwise report into the live site.
 */
import { useEffect, useRef } from 'react';
import type { Me } from './api';

/** Our Matomo instance. Trailing slash included — both URLs below append to it. */
const MATOMO_ORIGIN = 'https://piwik.brannon.online/';

/** The Nickel Bridge site in that instance. */
const SITE_ID = '4';

declare global {
  interface Window {
    /**
     * Matomo's command queue. A plain array of `[method, ...args]` rows until
     * matomo.js loads and swaps in its own object with a `push` of the same
     * shape, which is why every command here is queued rather than called:
     * the two are interchangeable to a caller, in either order.
     */
    _paq?: unknown[][];
  }
}

function queue(): unknown[][] {
  window._paq = window._paq ?? [];
  return window._paq;
}

/**
 * Hosts that must never report. Everything else is decided by the demo/devAuth
 * flags in `useAnalytics` — this covers only the case those flags can't see, a
 * production-configured server run on a developer's own machine.
 */
function isTrackableHost(hostname: string): boolean {
  return hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]' && !hostname.endsWith('.local');
}

/**
 * Configure the tracker and load matomo.js, once per page load. Deliberately
 * does NOT fire a page view: the first one comes from `useAnalytics` like
 * every other, so it carries the same custom URL treatment.
 *
 * Idempotency is a DOM check rather than a module flag so that the tag itself
 * is the record — a second call after a hot reload, or in a second test in the
 * same file, is a no-op for the same reason it is on a live page.
 */
function loadMatomo(): void {
  if (document.querySelector('script[data-matomo]')) return;
  const q = queue();
  q.push(['setTrackerUrl', `${MATOMO_ORIGIN}matomo.php`]);
  q.push(['setSiteId', SITE_ID]);
  q.push(['disableCookies']);
  q.push(['setDoNotTrack', true]);
  q.push(['enableLinkTracking']);
  const script = document.createElement('script');
  script.dataset.matomo = '';
  script.async = true;
  script.defer = true;
  script.src = `${MATOMO_ORIGIN}matomo.js`;
  document.head.appendChild(script);
}

/**
 * Does this deployment report at all?
 *
 * Note what it takes to say yes: a RESOLVED `/api/me`, saying neither demo nor
 * DEV_AUTH. `null` is not "a deployment with no flags set" — it is App.tsx
 * before the request lands, and equally App.tsx after it FAILED, since
 * `api.me()` throws on any non-2xx and refresh()'s `.finally` flips `loaded`
 * either way. Reading the flags off a null `me` gives `!undefined && !undefined`
 * — true — so the gate would turn analytics ON in exactly the case where the
 * app could not tell whether this is production or a preview, and the site id
 * is hardcoded. A cold-start 5xx while the Fly machine wakes is a realistic
 * way to reach that, so this fails CLOSED: an unknown deployment reports
 * nothing, which costs a few page views on a bad request and never puts
 * preview or demo traffic into the production site. Same shape as
 * pages/Scenarios.tsx's `Boolean(me?.demo)`, which hides the demo gallery
 * rather than guessing.
 */
export function reportsAnalytics(me: Me | null): boolean {
  return me != null && !me.demo && !me.devAuth;
}

/**
 * The URL a page view is recorded against.
 *
 * Path plus `?term=` and nothing else. The term sheet is a search param on
 * whatever route you are reading (glossary/GlossaryContext.tsx), so dropping
 * the query would collapse ~125 term reads — the single most useful thing this
 * measures — into one row for the page they were opened from. Every other
 * param is discarded rather than enumerated, so a future one can't start
 * reporting itself by accident.
 *
 * Path segments are left alone: player, tournament and board ids are already
 * in the request log, and Matomo groups a path hierarchy into folders, so
 * /t/17/b/3 reads as a navigable tree rather than a thousand flat rows.
 */
export function trackedUrl(pathname: string, search: string): string {
  const term = new URLSearchParams(search).get('term');
  return term ? `${pathname}?term=${encodeURIComponent(term)}` : pathname;
}

/**
 * Record one page view. `referrer` is the URL of the previous in-app view for
 * a router navigation, and null for the first view of a page load — where
 * Matomo's own `document.referrer` default is the right answer and this must
 * not overwrite it.
 */
function trackPageView(url: string, referrer: string | null): void {
  const q = queue();
  if (referrer) q.push(['setReferrerUrl', referrer]);
  q.push(['setCustomUrl', url]);
  q.push(['setDocumentTitle', document.title]);
  q.push(['trackPageView']);
  // Re-arm outbound/download link tracking over the DOM this navigation just
  // rendered. Matomo binds listeners to the elements present when it runs, so
  // in an SPA it has to be called again after each view or every link that
  // arrived with the new screen goes unmeasured.
  q.push(['enableLinkTracking']);
}

/**
 * Track router navigations as page views.
 *
 * `enabled` is the caller's judgment about whether this deployment reports at
 * all (App.tsx: `/api/me` has resolved and says neither demo nor DEV_AUTH), so
 * nothing loads — not even matomo.js — until it is true. The first view fires
 * on the same edge, which is why matomo.js is loaded lazily here rather than
 * at import: on a preview or the demo app it is never requested.
 */
export function useAnalytics(opts: { enabled: boolean; pathname: string; search: string }): void {
  const { enabled, pathname, search } = opts;
  // The URL of the last view recorded, and the guard against recording the
  // same one twice — App re-renders for reasons that have nothing to do with
  // navigation, and a term sheet closing restores a URL already counted.
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !isTrackableHost(window.location.hostname)) return;
    const url = `${window.location.origin}${trackedUrl(pathname, search)}`;
    if (url === last.current) return;
    const previous = last.current;
    last.current = url;
    loadMatomo();
    trackPageView(url, previous);
  }, [enabled, pathname, search]);
}
