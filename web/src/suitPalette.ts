/**
 * Suit color palette: an accessibility axis, orthogonal to night mode.
 *
 * Standard red/black (and this app's red/gold/green/black four-color deck) is a
 * well-known failure mode for red-green colorblindness (~8% of men) — hearts and
 * diamonds can collide. `data-suit-palette="colorblind"` on <html> swaps the
 * `--suit-h`/`--suit-d` tokens (and their `--cardface-suit-*`/`--onprimary-suit-*`
 * derivatives) to a blue/orange pair, the standard safe substitute — blue and
 * orange sit on the tritan axis, which red-green deficiency leaves intact. Spades
 * and clubs are untouched: clubs already sits off the red-green collision axis, and
 * narrowing the swap to the pair that actually collides keeps the ink-on-paper
 * palette otherwise unchanged.
 *
 * Deliberately a SECOND, INDEPENDENT device-local axis rather than a fifth
 * Appearance option: a colorblind player wants both a day AND a night variant of
 * the safe palette, exactly as a sighted player wants both variants of the
 * standard one. This mirrors theme.ts's `day`/`night` override pattern one level
 * down — `[data-suit-palette="colorblind"]` composes with `[data-theme="night"]` in
 * style.css rather than replacing it.
 *
 * Unlike theme.ts, this has no `system`/`adaptive` equivalent — there is no OS
 * media feature for color-vision deficiency and no time-of-day concept for it — so
 * there's nothing here for App.tsx to re-apply on a timer or listener. Applied
 * exactly twice, the same as appearance: once by the blocking inline script in
 * index.html (before first paint), and again by applySuitPalette when the settings
 * gate's switch is flipped. Keep the two in sync by hand — see index.html's comment.
 */

export type SuitPalette = 'standard' | 'colorblind';

export const SUIT_PALETTE_KEY = 'nb:suitPalette';

function isSuitPalette(v: unknown): v is SuitPalette {
  return v === 'standard' || v === 'colorblind';
}

/** Best-effort read; unreadable storage or an unrecognized stamp falls back to 'standard'. */
export function readSuitPalette(): SuitPalette {
  try {
    const v = localStorage.getItem(SUIT_PALETTE_KEY);
    return isSuitPalette(v) ? v : 'standard';
  } catch {
    return 'standard';
  }
}

/** Best-effort write — a failed write just means the choice doesn't survive a reload. */
export function storeSuitPalette(pref: SuitPalette): void {
  try {
    localStorage.setItem(SUIT_PALETTE_KEY, pref);
  } catch {
    /* ignore */
  }
}

/**
 * Sets `data-suit-palette` on <html> ('standard' removes it, since the base
 * `:root` block already IS the standard palette — there's nothing for a
 * `data-suit-palette="standard"` value to select against, unlike appearance's
 * 'system' which has a real media-query fallback to defer to).
 */
export function applySuitPalette(pref: SuitPalette): void {
  const root = document.documentElement;
  if (pref === 'colorblind') {
    root.setAttribute('data-suit-palette', 'colorblind');
  } else {
    root.removeAttribute('data-suit-palette');
  }
}
