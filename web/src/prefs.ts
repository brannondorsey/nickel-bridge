/**
 * Device-local play preferences (the settings tab's rows that never leave this
 * browser). Night mode is the older sibling and keeps its own module, theme.ts,
 * because it has to be applied before first paint by an inline script; these
 * are read at the moment they matter and need no such duplication.
 *
 * Same best-effort storage contract as theme.ts: an unreadable or unwritable
 * localStorage (private browsing, a wiped profile) degrades to the default
 * rather than throwing — a preference failing to persist must never break the
 * screen it belongs to, let alone the board it affects.
 */

export const FAST_FORWARD_KEY = 'nb:fastForward';

/**
 * Fast-forward the settled tricks after a claim.
 *
 * Worth being precise about what this does and does not do, because the name
 * invites the wrong reading: when the server resolves a claim it has ALREADY
 * played every remaining card (server/src/game.ts's resolveClaim) — the
 * response arrives with the board finished. Nobody chooses a card in that tail
 * under either setting, so this is a pacing preference and nothing more: on
 * (the default, and the behaviour that shipped) replays the tail compressed at
 * CLAIM_SPEEDUP_FACTOR, off replays it at ordinary play pacing so it can be
 * watched trick by trick. It has no effect at all under prefers-reduced-motion,
 * where there is no replay to pace (see motionOK in playAnim.ts).
 */
export function readFastForward(): boolean {
  try {
    return localStorage.getItem(FAST_FORWARD_KEY) !== '0';
  } catch {
    return true;
  }
}

export function storeFastForward(on: boolean): void {
  try {
    localStorage.setItem(FAST_FORWARD_KEY, on ? '1' : '0');
  } catch {
    /* ignore — the choice just doesn't survive a reload */
  }
}
