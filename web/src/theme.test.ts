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

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('readThemePref', () => {
  it('defaults to system with no stamp', () => {
    expect(readThemePref()).toBe('system');
  });

  it('reads a stored day/night/system value', () => {
    localStorage.setItem(THEME_KEY, 'night');
    expect(readThemePref()).toBe('night');
    localStorage.setItem(THEME_KEY, 'day');
    expect(readThemePref()).toBe('day');
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
