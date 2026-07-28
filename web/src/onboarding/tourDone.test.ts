import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOUR_DONE_KEY, claimIsFresh, clearTourDone, peekTourDone, stampTourDone } from './tourDone';

const now = new Date('2026-07-14T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60 * 1000).toISOString();

describe('claimIsFresh', () => {
  it('is no claim at all when nothing was ever stamped', () => {
    expect(claimIsFresh(null, now)).toBe(false);
  });

  it('ignores an unparseable stamp rather than trusting it', () => {
    expect(claimIsFresh('not-a-date', now)).toBe(false);
  });

  it('holds across an ordinary OAuth round trip', () => {
    expect(claimIsFresh(minutesAgo(0), now)).toBe(true);
    expect(claimIsFresh(minutesAgo(59), now)).toBe(true);
  });

  // An abandoned sign-in leaves the flag behind. Without an expiry, whoever
  // signs in on that browser next week silently skips onboarding they never saw.
  it('expires, so an abandoned sign-in cannot skip someone else past the tour', () => {
    expect(claimIsFresh(minutesAgo(60), now)).toBe(false);
    expect(claimIsFresh(minutesAgo(60 * 24 * 7), now)).toBe(false);
  });

  it('treats a future stamp as clock skew, not a forgery — the worst it can do is skip a tutorial', () => {
    expect(claimIsFresh(minutesAgo(-30), now)).toBe(true);
  });
});

describe('localStorage wrappers', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('stamps a claim peek accepts, and clear spends', () => {
    stampTourDone(now);
    expect(localStorage.getItem(TOUR_DONE_KEY)).toBe(now.toISOString());
    expect(peekTourDone(now)).toBe(true);
    clearTourDone();
    expect(peekTourDone(now)).toBe(false);
  });

  // StrictMode double-invokes the useState initializer that calls this, so a
  // read that consumed the claim would lose it on the throwaway pass.
  it('peek does not consume the claim', () => {
    stampTourDone(now);
    expect(peekTourDone(now)).toBe(true);
    expect(peekTourDone(now)).toBe(true);
    expect(localStorage.getItem(TOUR_DONE_KEY)).not.toBeNull();
  });

  it('degrades to no claim on broken storage, and never throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    // no claim means the tour shows again — being taught twice beats being
    // locked out of onboarding
    expect(peekTourDone(now)).toBe(false);
    expect(() => stampTourDone(now)).not.toThrow();
    expect(() => clearTourDone()).not.toThrow();
  });
});
