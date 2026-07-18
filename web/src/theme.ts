/**
 * Night mode activation: OS default, settings override.
 *
 * Default is `system` — no stored preference, no `data-theme` attribute, the CSS
 * `@media (prefers-color-scheme: dark)` copy of the token block in style.css decides.
 * `day`/`night` are explicit overrides that set `data-theme` on <html>, which always
 * wins over the media query (see the `:not([data-theme])` scoping in style.css).
 * The persisted choice is applied twice: once by a blocking inline script in
 * index.html (before first paint, so there's no light-mode flash) duplicating the
 * logic below in plain JS since it must run before this module loads, and again by
 * applyThemePref when the user flips the Stats page switch.
 */

export type ThemePref = 'day' | 'night' | 'system';

export const THEME_KEY = 'nb:theme';

const NIGHT_THEME_COLOR = '#171512';
const DAY_THEME_COLOR = '#fcfbf8';

function isThemePref(v: unknown): v is ThemePref {
  return v === 'day' || v === 'night' || v === 'system';
}

/** Best-effort read; unreadable storage or an unrecognized stamp falls back to 'system'. */
export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isThemePref(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Best-effort write — a failed write just means the choice doesn't survive a reload. */
export function storeThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* ignore */
  }
}

function systemPrefersNight(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolvesToNight(pref: ThemePref): boolean {
  return pref === 'night' || (pref === 'system' && systemPrefersNight());
}

/**
 * Sets `data-theme` on <html> ('system' removes it, so the media-query copy of the
 * token block applies) and the <meta name="theme-color"> Chrome reads for the address
 * bar / task switcher.
 */
export function applyThemePref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', pref === 'night' ? 'night' : 'light');
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolvesToNight(pref) ? NIGHT_THEME_COLOR : DAY_THEME_COLOR);
}
