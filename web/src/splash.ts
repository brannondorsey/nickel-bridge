/**
 * Returning-visitor gate for the splash intro.
 *
 * Logged-in users see the splash again only after 3+ days away, tracked via
 * localStorage ('nb:lastVisit', stamped on every authenticated mount). The
 * pure decision lives in shouldShowSplash; the wrappers isolate localStorage,
 * which can throw (Safari private mode, blocked storage) — in that case we
 * treat the visitor as recent rather than replaying the intro on every load.
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
