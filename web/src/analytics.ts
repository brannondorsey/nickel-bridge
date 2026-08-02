/**
 * Analytics — Google Analytics 4 (gtag.js), and nothing else.
 *
 * The app has no other measurement: the only other signal about whether anyone
 * reads the glossary, finishes the tour, or bounces off the landing page is the
 * request log, which answers "who woke the machine" (see server/src/logging.ts)
 * and not much more.
 *
 * WHAT THIS MEANS FOR VISITORS, stated plainly because it is a real property of
 * the app rather than an implementation detail. Page views leave our
 * infrastructure and go to Google, and whether that comes with a cookie depends
 * on where the visitor is: Consent Mode defaults deny `analytics_storage` in
 * CONSENT_REGIONS (the EEA and the UK, where analytics storage needs opt-in
 * consent this app has no way to ask for) and grant it everywhere else. Ad
 * storage is denied for everyone, in every region — the app runs no ads and
 * there is nothing here worth an advertising cookie.
 *
 * So there are two populations in the reports, and reading them as one is the
 * mistake this comment exists to prevent. A granted visitor carries a `_ga`
 * cookie and behaves like normal GA: returning visits join up, retention and
 * attribution mean what they say. A denied visitor stores nothing, so their
 * client id lives in memory for one page load — an SPA visit shares one id, but
 * a reload, a return tomorrow or a second tab is a brand-new "user", and GA
 * receives cookieless pings it may model from. **Users is therefore inflated in
 * the EEA/UK relative to everywhere else, and any retention or cohort figure
 * that mixes the two is a blend of two different measurements.** Segment by
 * region or don't read it. What is honest for everyone is the within-visit
 * path: which pages and which glossary terms get read, and in what order.
 *
 * Note what this does NOT settle. Consent Mode answers the storage question —
 * ePrivacy, the cookie-banner one. Whether sending a visitor's IP and user
 * agent to a US analytics provider needs a lawful basis under GDPR is a
 * separate question this config does not answer, and no region list can.
 *
 * One thing it does NOT cost: the Fly machine. gtag.js is served by
 * googletagmanager.com and hits land on Google's collectors, so none of this
 * shows up as a request that wakes or holds the app's dedicated core (see
 * CLAUDE.md, "Machine time is bought by the request"). It is outside the
 * Cloudflare rules derived from seo.ts for the same reason: different host.
 *
 * WHY NOT THE STOCK <script> SNIPPET. `gtag('config', ID)` sends one page_view
 * on load, which for a client-rendered SPA means every visit is recorded as a
 * single hit on whatever URL the visitor entered on — the glossary term they
 * went on to read, the tour they walked and the boards they played are all
 * invisible. So `send_page_view` is off in the config and `useAnalytics` below
 * sends every view itself, including the first, from App.tsx's router state.
 * (Enhanced measurement — outbound clicks, scroll depth, site search — is
 * configured in the GA property rather than here; unlike Matomo's link
 * tracking it needs no re-arming after each SPA navigation.)
 *
 * WHERE IT IS DISABLED, and why the check is a round trip rather than a
 * hostname: the demo app and every PR preview serve a byte-identical bundle
 * from their own hostnames, and their traffic is bots, seeders and
 * click-testing — exactly the same reason seo.ts's `throwaway` flag shuts
 * crawlers out of them. `/api/me` already reports `demo`/`devAuth` and App.tsx
 * already fetches it before rendering anything, so that flag is reused here
 * instead of pinning a production hostname into the bundle. Local development
 * is excluded by hostname on top of that, since a locally built server with
 * neither flag set would otherwise report into the live property.
 */
import { useEffect, useRef } from 'react';
import type { Me } from './api';

/** The GA4 measurement id for Nickel Bridge. */
const MEASUREMENT_ID = 'G-ZTL1SZ7ZKZ';

/**
 * Where analytics storage is denied by default: the EEA (EU 27 + Iceland,
 * Liechtenstein, Norway) and the UK. ISO 3166-1 country codes, which Consent
 * Mode's `region` accepts alongside finer ISO 3166-2 subdivisions.
 *
 * The line these draw is ePrivacy's: storing or reading anything on a device
 * needs opt-in consent there, and this app has no consent UI to ask with — so
 * a visitor in one of these gets the cookieless treatment automatically rather
 * than a banner. Everywhere else keeps the ordinary `_ga` cookie, which is
 * what makes returning visitors visible at all.
 *
 * Switzerland is deliberately NOT here: the revised FADP requires transparency
 * rather than ePrivacy-style opt-in for analytics storage. Add 'CH' if you'd
 * rather be conservative than accurate — it costs one country's returning-user
 * data and nothing else.
 */
const CONSENT_REGIONS = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
  'GB',
];

declare global {
  interface Window {
    /**
     * gtag.js's command queue: `arguments` objects, pushed before and after
     * the tag itself loads and replayed by it on arrival. Typed loosely
     * because that is genuinely what it holds — see `gtag` below for why the
     * rows are `arguments` and not arrays.
     */
    dataLayer?: unknown[];
  }
}

function dataLayer(): unknown[] {
  window.dataLayer = window.dataLayer ?? [];
  return window.dataLayer;
}

/**
 * Queue one gtag command.
 *
 * Pushes `arguments` rather than the rest array, exactly as Google's snippet
 * does. gtag.js reads each queued row as an arguments-like object and is
 * documented against that shape; an array happens to work today, but this is
 * not the place to bet on an undocumented equivalence. The rest parameter is
 * here for the call-site types only.
 */
function gtag(..._args: unknown[]): void {
  dataLayer().push(arguments);
}

/**
 * Hosts that must never report. Everything else is decided by the demo/devAuth
 * flags in `reportsAnalytics` — this covers only the case those flags can't
 * see, a production-configured server run on a developer's own machine.
 */
function isTrackableHost(hostname: string): boolean {
  return hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]' && !hostname.endsWith('.local');
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
 * app could not tell whether this is production or a preview, and the
 * measurement id is hardcoded. A cold-start 5xx while the Fly machine wakes is
 * a realistic way to reach that, so this fails CLOSED: an unknown deployment
 * reports nothing, which costs a few page views on a bad request and never
 * puts preview or demo traffic into the production property. Same shape as
 * pages/Scenarios.tsx's `Boolean(me?.demo)`, which hides the demo gallery
 * rather than guessing.
 */
export function reportsAnalytics(me: Me | null): boolean {
  return me != null && !me.demo && !me.devAuth;
}

/**
 * Queue the consent defaults, the `js` stamp and the config, then load
 * gtag.js — once per page load.
 *
 * ORDER IS LOAD-BEARING. The consent defaults must be queued before the config
 * command, or gtag applies its own defaults (storage granted everywhere) and
 * the EEA/UK denial arrives too late to have prevented the cookie it exists to
 * prevent. Queueing before the <script> tag is inserted isn't required —
 * gtag.js replays the queue in order and can't execute until this synchronous
 * block finishes — but it keeps the reading order the same as the running one.
 *
 * Two defaults, as Consent Mode resolves them (most specific region wins): the
 * region-scoped one denies analytics storage across CONSENT_REGIONS, and the
 * unscoped one grants it everywhere else. Ad storage is denied in both, in
 * every region — the app runs no ads under any flag, so there is nothing here
 * an advertising cookie could be for.
 *
 * `send_page_view: false` is the other non-default: the first view comes from
 * `useAnalytics` like every other, so it carries the same URL treatment as the
 * rest. Left on, gtag would send its own view of the entry URL and every visit
 * would be double-counted at its front door.
 *
 * Idempotency is a DOM check rather than a module flag so that the tag itself
 * is the record — a second call after a hot reload, or in a second test in the
 * same file, is a no-op for the same reason it is on a live page.
 */
function loadGtag(): void {
  if (document.querySelector('script[data-gtag]')) return;
  const noAds = { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' } as const;
  gtag('consent', 'default', { ...noAds, analytics_storage: 'denied', region: CONSENT_REGIONS });
  gtag('consent', 'default', { ...noAds, analytics_storage: 'granted' });
  gtag('js', new Date());
  gtag('config', MEASUREMENT_ID, { send_page_view: false });
  const script = document.createElement('script');
  script.dataset.gtag = '';
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(script);
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
 * in the request log, and GA's page-path reports group a hierarchy well enough
 * that /t/17/b/3 stays navigable.
 */
export function trackedUrl(pathname: string, search: string): string {
  const term = new URLSearchParams(search).get('term');
  return term ? `${pathname}?term=${encodeURIComponent(term)}` : pathname;
}

/**
 * Record one page view. `referrer` is the URL of the previous in-app view for
 * a router navigation, and null for the first view of a page load — where
 * gtag's own `document.referrer` default is the right answer and this must not
 * overwrite it.
 *
 * `title` is PASSED, never read off `document.title`, and that is not a
 * stylistic preference. React runs a component's effects in hook-registration
 * order, and this hook is registered before App.tsx's title effect — so an
 * ambient read here happens while the tab still says whatever the PREVIOUS
 * screen set, and every page view would be reported against the previous
 * page's title, forever one step behind. Threading the value removes the
 * ordering dependency instead of relying on someone preserving it.
 */
function trackPageView(url: string, referrer: string | null, title: string): void {
  gtag('event', 'page_view', {
    page_location: url,
    page_title: title,
    ...(referrer ? { page_referrer: referrer } : {}),
  });
}

/**
 * Track router navigations as page views.
 *
 * `enabled` is the caller's judgment about whether this deployment reports at
 * all (App.tsx: `reportsAnalytics(me)`), so nothing loads — not even gtag.js —
 * until it is true. The first view fires on the same edge, which is why the
 * tag is loaded lazily here rather than at import: on a preview or the demo
 * app it is never requested.
 */
export function useAnalytics(opts: { enabled: boolean; pathname: string; search: string; title: string }): void {
  const { enabled, pathname, search, title } = opts;
  // The URL of the last view recorded. It guards against reporting the same
  // URL twice in a row — App re-renders for reasons that have nothing to do
  // with navigation, StrictMode double-invokes this effect, and `enabled`
  // flipping re-runs it — and that is ALL it guards: one slot, not a history.
  //
  // So closing a term sheet does record a fresh view of the page underneath
  // (/glossary → ?term=finesse → /glossary is three views, not two), and a
  // reader opening ten terms off the index credits /glossary eleven times.
  // That's kept deliberately: each of those is a real navigation the reader
  // made, and GA counts a return to a page as a view everywhere else in the
  // app. Suppressing it would need a history of visited URLs and would
  // undercount genuine back-navigation to say something less true.
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !isTrackableHost(window.location.hostname)) return;
    const url = `${window.location.origin}${trackedUrl(pathname, search)}`;
    if (url === last.current) return;
    const previous = last.current;
    last.current = url;
    loadGtag();
    trackPageView(url, previous, title);
    // `title` is deliberately NOT a dependency. It is derived from the same
    // (pathname, search) this effect already keys on, so the closure always
    // holds the right one; and a page that later refines its own title should
    // not thereby record a second view of a URL already counted.
  }, [enabled, pathname, search]);
}
