/**
 * Returning-visitor gate for the splash intro.
 *
 * Logged-in users see the splash again only after 3+ days away, tracked via
 * localStorage ('nb:lastVisit', stamped on every authenticated mount). The
 * pure decision lives in shouldShowSplash; the wrappers isolate localStorage,
 * which can throw (Safari private mode, blocked storage) — in that case we
 * treat the visitor as recent rather than replaying the intro on every load.
 *
 * The stamp has a second reader: web/index.html's pre-paint script sets
 * data-returning-player from it, which is what suppresses the prerendered
 * static fallback (web/scripts/prerender.mjs) for a browser that has signed
 * in before — see CONTRIBUTING.md's "Discoverability" section. That's why
 * clearVisitStamp exists: without it, signing out leaves the claim in place
 * forever, and an anonymous visitor on a now-signed-out (or shared) browser
 * would keep losing the fast static paint for a session that no longer
 * exists.
 */

export const LAST_VISIT_KEY = 'nb:lastVisit';

const SPLASH_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** Never visited (or unparseable stamp) → splash. 3+ days ago → splash. A future stamp is clock skew → no splash. */
export function shouldShowSplash(lastVisit: string | null, now: Date): boolean {
  if (!lastVisit) return true;
  const then = Date.parse(lastVisit);
  if (Number.isNaN(then)) return true;
  const age = now.getTime() - then;
  if (age < 0) return false;
  return age >= SPLASH_AFTER_MS;
}

/** Read the stamp and decide; storage failure counts as a recent visit. */
export function splashOnReturn(now: Date = new Date()): boolean {
  let lastVisit: string | null;
  try {
    lastVisit = localStorage.getItem(LAST_VISIT_KEY);
  } catch {
    return false;
  }
  return shouldShowSplash(lastVisit, now);
}

/** Best-effort visit stamp — a failed write just means an extra splash someday. */
export function stampVisit(now: Date = new Date()): void {
  try {
    localStorage.setItem(LAST_VISIT_KEY, now.toISOString());
  } catch {
    /* ignore */
  }
}

/**
 * Sign-out's counterpart to stampVisit: drop the claim that this browser has
 * ever held a session, so the next load reads as a first-time arrival again
 * rather than a signed-out player still wearing the returning-player mark.
 * Best-effort like the stamp itself — a failed remove costs one skipped
 * static paint next load, never a broken sign-out.
 */
export function clearVisitStamp(): void {
  try {
    localStorage.removeItem(LAST_VISIT_KEY);
  } catch {
    /* ignore */
  }
}
