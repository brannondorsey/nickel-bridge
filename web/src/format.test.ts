import { describe, expect, it } from 'vitest';
import { ordinal, shortDate, shortDateUTC, timeGreeting } from './format';

describe('ordinal', () => {
  it('handles 1st/2nd/3rd and the teens', () => {
    expect(ordinal(1)).toBe('1ST');
    expect(ordinal(2)).toBe('2ND');
    expect(ordinal(3)).toBe('3RD');
    expect(ordinal(4)).toBe('4TH');
    expect(ordinal(11)).toBe('11TH');
    expect(ordinal(12)).toBe('12TH');
    expect(ordinal(13)).toBe('13TH');
    expect(ordinal(21)).toBe('21ST');
    expect(ordinal(102)).toBe('102ND');
    expect(ordinal(111)).toBe('111TH');
  });
});

describe('shortDate', () => {
  it('renders month + day from unix seconds', () => {
    // 2026-07-09T12:00:00Z — midday avoids timezone flakiness for any UTC±11 runner
    expect(shortDate(1_783_598_400)).toMatch(/^Jul 9$/);
  });
});

describe('shortDateUTC', () => {
  it('renders a UTC calendar-day bucket without shifting for the runner’s local timezone', () => {
    // 2026-07-09T00:00:00Z — UTC midnight, the exact instant a local-time
    // formatter (shortDate) rolls back to the previous day for any
    // timezone west of UTC. Unlike shortDate's own test above, this one is
    // deliberately picked AT the boundary rather than avoiding it — that's
    // the whole point of shortDateUTC (DayGrid's day buckets, which are
    // always UTC midnight via dateToUnix).
    expect(shortDateUTC(1_783_555_200)).toBe('Jul 9');
  });
});

describe('timeGreeting', () => {
  it('maps hours to morning/afternoon/evening', () => {
    expect(timeGreeting(5)).toBe('morning');
    expect(timeGreeting(11)).toBe('morning');
    expect(timeGreeting(12)).toBe('afternoon');
    expect(timeGreeting(17)).toBe('afternoon');
    expect(timeGreeting(18)).toBe('evening');
    expect(timeGreeting(23)).toBe('evening');
    expect(timeGreeting(2)).toBe('evening');
  });
});
