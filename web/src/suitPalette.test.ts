import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUIT_PALETTE_KEY, applySuitPalette, readSuitPalette, storeSuitPalette } from './suitPalette';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-suit-palette');
  vi.restoreAllMocks();
});

describe('readSuitPalette', () => {
  it('defaults to standard with no stamp', () => {
    expect(readSuitPalette()).toBe('standard');
  });

  it('reads a stored colorblind value', () => {
    localStorage.setItem(SUIT_PALETTE_KEY, 'colorblind');
    expect(readSuitPalette()).toBe('colorblind');
  });

  it('falls back to standard for garbage or unreadable storage', () => {
    localStorage.setItem(SUIT_PALETTE_KEY, 'sepia');
    expect(readSuitPalette()).toBe('standard');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readSuitPalette()).toBe('standard');
  });
});

describe('storeSuitPalette', () => {
  it('writes a stamp readSuitPalette accepts, and never throws on denial', () => {
    storeSuitPalette('colorblind');
    expect(localStorage.getItem(SUIT_PALETTE_KEY)).toBe('colorblind');
    expect(readSuitPalette()).toBe('colorblind');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => storeSuitPalette('standard')).not.toThrow();
  });
});

describe('applySuitPalette', () => {
  it('sets data-suit-palette for colorblind and removes it for standard', () => {
    applySuitPalette('colorblind');
    expect(document.documentElement.getAttribute('data-suit-palette')).toBe('colorblind');
    applySuitPalette('standard');
    expect(document.documentElement.hasAttribute('data-suit-palette')).toBe(false);
  });
});
