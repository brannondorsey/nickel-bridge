/**
 * Night mode activation: OS default, settings override.
 *
 * Default is `system` — no stored preference, no `data-theme` attribute, the CSS
 * `@media (prefers-color-scheme: dark)` copy of the token block in style.css decides.
 * `day`/`night` are explicit overrides that set `data-theme` on <html>, which always
 * wins over the media query (see the `:not([data-theme])` scoping in style.css).
 * `adaptive` is a third kind of override: it also sets `data-theme` explicitly (there's
 * no CSS media query for time-of-day), but recomputes which one on a fixed local-time
 * schedule — night from `ADAPTIVE_NIGHT_START_HOUR` to `ADAPTIVE_NIGHT_END_HOUR` — rather
 * than following the OS. The window matches the industry-standard fixed dark-mode
 * schedule (e.g. Windows Night Light's default "set hours" of 9 PM-7 AM) rather than a
 * sunset/sunrise calculation, since that needs geolocation this app doesn't request.
 * The persisted choice is applied twice: once by a blocking inline script in
 * index.html (before first paint, so there's no light-mode flash) duplicating the
 * logic below in plain JS since it must run before this module loads, and again by
 * applyThemePref when the user flips the Stats page switch. Because `adaptive` can
 * flip while the tab stays open, App.tsx also re-applies it on a timer — see the
 * effect there for why `system`'s OS-change listener isn't enough on its own.
 */

export type ThemePref = 'day' | 'night' | 'system' | 'adaptive';

export const THEME_KEY = 'nb:theme';

/** Local-time window `adaptive` treats as night — see the module doc comment above. */
export const ADAPTIVE_NIGHT_START_HOUR = 21; // 9 PM
export const ADAPTIVE_NIGHT_END_HOUR = 7; // 7 AM

const NIGHT_THEME_COLOR = '#171512';
const DAY_THEME_COLOR = '#fcfbf8';

function isThemePref(v: unknown): v is ThemePref {
  return v === 'day' || v === 'night' || v === 'system' || v === 'adaptive';
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

function adaptivePrefersNight(): boolean {
  const hour = new Date().getHours();
  return hour >= ADAPTIVE_NIGHT_START_HOUR || hour < ADAPTIVE_NIGHT_END_HOUR;
}

export function resolvesToNight(pref: ThemePref): boolean {
  return (
    pref === 'night' || (pref === 'system' && systemPrefersNight()) || (pref === 'adaptive' && adaptivePrefersNight())
  );
}

/**
 * Sets `data-theme` on <html> ('system' removes it, so the media-query copy of the
 * token block applies; 'adaptive' has no media-query equivalent, so it sets an explicit
 * value same as 'day'/'night') and the <meta name="theme-color"> Chrome reads for the
 * address bar / task switcher.
 */
export function applyThemePref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', resolvesToNight(pref) ? 'night' : 'light');
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolvesToNight(pref) ? NIGHT_THEME_COLOR : DAY_THEME_COLOR);
}
