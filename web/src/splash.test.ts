import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAST_VISIT_KEY, shouldShowSplash, splashOnReturn, stampVisit } from './splash';

const now = new Date('2026-07-14T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

describe('shouldShowSplash', () => {
  it('shows for a first-time visitor (no stamp)', () => {
    expect(shouldShowSplash(null, now)).toBe(true);
  });

  it('shows for an unparseable stamp', () => {
    expect(shouldShowSplash('not-a-date', now)).toBe(true);
  });

  it('skips for a recent visitor', () => {
    expect(shouldShowSplash(daysAgo(0), now)).toBe(false);
    expect(shouldShowSplash(daysAgo(2.9), now)).toBe(false);
  });

  it('shows again after 3+ days away', () => {
    expect(shouldShowSplash(daysAgo(3), now)).toBe(true);
    expect(shouldShowSplash(daysAgo(30), now)).toBe(true);
  });

  it('treats a future stamp (clock skew) as recent', () => {
    expect(shouldShowSplash(daysAgo(-1), now)).toBe(false);
  });
});

describe('localStorage wrappers', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('splashOnReturn reads the stamp', () => {
    localStorage.setItem(LAST_VISIT_KEY, daysAgo(5));
    expect(splashOnReturn(now)).toBe(true);
    localStorage.setItem(LAST_VISIT_KEY, daysAgo(1));
    expect(splashOnReturn(now)).toBe(false);
  });

  it('stampVisit writes an ISO stamp splashOnReturn accepts', () => {
    stampVisit(now);
    expect(localStorage.getItem(LAST_VISIT_KEY)).toBe(now.toISOString());
    expect(splashOnReturn(now)).toBe(false);
  });

  it('treats broken storage as a recent visit and never throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(splashOnReturn(now)).toBe(false);
    expect(() => stampVisit(now)).not.toThrow();
  });
});
