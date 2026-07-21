import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY, applyThemePref, readThemePref, resolvesToNight, storeThemePref } from './theme';

function mockMatchMedia(prefersDark: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: prefersDark,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}

function mockHour(hour: number) {
  vi.useFakeTimers();
  const now = new Date();
  now.setHours(hour, 0, 0, 0);
  vi.setSystemTime(now);
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('readThemePref', () => {
  it('defaults to system with no stamp', () => {
    expect(readThemePref()).toBe('system');
  });

  it('reads a stored day/night/adaptive/system value', () => {
    localStorage.setItem(THEME_KEY, 'night');
    expect(readThemePref()).toBe('night');
    localStorage.setItem(THEME_KEY, 'day');
    expect(readThemePref()).toBe('day');
    localStorage.setItem(THEME_KEY, 'adaptive');
    expect(readThemePref()).toBe('adaptive');
  });

  it('falls back to system for garbage or unreadable storage', () => {
    localStorage.setItem(THEME_KEY, 'sunset');
    expect(readThemePref()).toBe('system');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readThemePref()).toBe('system');
  });
});

describe('storeThemePref', () => {
  it('writes a stamp readThemePref accepts, and never throws on denial', () => {
    storeThemePref('night');
    expect(localStorage.getItem(THEME_KEY)).toBe('night');
    expect(readThemePref()).toBe('night');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => storeThemePref('day')).not.toThrow();
  });
});

describe('resolvesToNight', () => {
  it('is night for the explicit override regardless of OS', () => {
    mockMatchMedia(false);
    expect(resolvesToNight('night')).toBe(true);
  });

  it('is never night for the explicit day override, even under a dark OS', () => {
    mockMatchMedia(true);
    expect(resolvesToNight('day')).toBe(false);
  });

  it('follows the OS under system', () => {
    mockMatchMedia(true);
    expect(resolvesToNight('system')).toBe(true);
    mockMatchMedia(false);
    expect(resolvesToNight('system')).toBe(false);
  });

  it('follows the fixed 9 PM-7 AM local-time window under adaptive, regardless of OS', () => {
    mockMatchMedia(false);
    mockHour(22); // 10 PM
    expect(resolvesToNight('adaptive')).toBe(true);
    mockHour(3); // 3 AM
    expect(resolvesToNight('adaptive')).toBe(true);
    mockHour(21); // exactly 9 PM
    expect(resolvesToNight('adaptive')).toBe(true);
    mockHour(20); // 8 PM
    expect(resolvesToNight('adaptive')).toBe(false);
    mockHour(7); // exactly 7 AM
    expect(resolvesToNight('adaptive')).toBe(false);
    mockHour(13); // 1 PM
    expect(resolvesToNight('adaptive')).toBe(false);
  });
});

describe('applyThemePref', () => {
  it('sets data-theme for explicit day/night and removes it for system', () => {
    applyThemePref('night');
    expect(document.documentElement.getAttribute('data-theme')).toBe('night');
    applyThemePref('day');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    applyThemePref('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('sets an explicit data-theme for adaptive, unlike system', () => {
    mockHour(23); // 11 PM
    applyThemePref('adaptive');
    expect(document.documentElement.getAttribute('data-theme')).toBe('night');
    mockHour(13); // 1 PM
    applyThemePref('adaptive');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('sets the theme-color meta to the night or day value', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
    try {
      mockMatchMedia(false);
      applyThemePref('night');
      expect(meta.getAttribute('content')).toBe('#171512');
      applyThemePref('day');
      expect(meta.getAttribute('content')).toBe('#fcfbf8');
    } finally {
      meta.remove();
    }
  });
});
