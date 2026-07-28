/**
 * The tour claim: "this browser already walked the first crossing."
 *
 * /tour reads without an account, so a visitor can finish the whole practice
 * board before they have one — and then sign in, land back on `/` as a brand-new
 * account with onboarded_at NULL, and be handed the same practice board they
 * just walked (App.tsx's arrival gate). This flag is what closes that loop:
 * the tour stamps it on the way out to the sign-in door, and App.tsx trades it
 * for the server-side POST /api/me/onboarded once a session exists.
 *
 * Storage discipline copied from splash.ts (nb:lastVisit): localStorage can
 * throw outright — Safari private mode, blocked third-party storage — so every
 * access is wrapped, and a failure degrades to *showing* the tour. Being taught
 * twice is a bad minute; being locked out of onboarding is worse.
 *
 * Three details that are load-bearing rather than defensive:
 *
 * - **The read is non-destructive.** main.tsx wraps the app in StrictMode,
 *   which double-invokes component bodies and useState initializers in
 *   development; a read-and-clear in an initializer would consume the flag on
 *   the throwaway pass and lose it. peek and clear are separate calls, and only
 *   the effect that actually reaches the server clears.
 * - **It expires.** A visitor who walks the tour and then abandons the Google
 *   redirect leaves the flag behind indefinitely, and whoever signs in on that
 *   browser next would silently skip onboarding they never saw. An hour is far
 *   longer than an OAuth round trip and far shorter than "next week".
 * - **The value is a timestamp, not `'1'`**, purely so the expiry above has
 *   something to read. An unparseable or future value is treated as no claim.
 */

export const TOUR_DONE_KEY = 'nb:tourDone';

/** How long a claim stays good — one OAuth round trip, generously. */
const CLAIM_TTL_MS = 60 * 60 * 1000;

/** Pure decision, so the expiry is testable without touching the clock. */
export function claimIsFresh(stamp: string | null, now: Date): boolean {
  if (!stamp) return false;
  const then = Date.parse(stamp);
  if (Number.isNaN(then)) return false;
  const age = now.getTime() - then;
  // A future stamp is clock skew, not a forgery to defend against — the worst
  // it can do is skip a tutorial, so treat it as the fresh claim it looks like.
  if (age < 0) return true;
  return age < CLAIM_TTL_MS;
}

/** Record that this browser finished the tour. Best effort; a failed write just means it replays. */
export function stampTourDone(now: Date = new Date()): void {
  try {
    localStorage.setItem(TOUR_DONE_KEY, now.toISOString());
  } catch {
    /* ignore */
  }
}

/** Is there a live claim? Reads only — see the StrictMode note above. */
export function peekTourDone(now: Date = new Date()): boolean {
  try {
    return claimIsFresh(localStorage.getItem(TOUR_DONE_KEY), now);
  } catch {
    return false;
  }
}

/** Drop the claim, spent or stale. */
export function clearTourDone(): void {
  try {
    localStorage.removeItem(TOUR_DONE_KEY);
  } catch {
    /* ignore */
  }
}
