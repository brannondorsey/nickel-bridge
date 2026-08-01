/**
 * Run this file on a production-shaped URL. jsdom's default is localhost,
 * which analytics.ts deliberately refuses to report from — see isTrackableHost.
 *
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://bridge.brannon.online/" }
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { trackedUrl, useAnalytics } from './analytics';

/** Rows queued for Matomo so far, as `[method, ...args]` tuples. */
const commands = () => (window._paq ?? []).map((row) => row as unknown[]);
const methods = () => commands().map((row) => row[0]);
const injected = () => document.querySelectorAll('script[data-matomo]');

beforeEach(() => {
  window._paq = [];
  injected().forEach((s) => s.remove());
});

afterEach(() => {
  delete window._paq;
});

describe('trackedUrl', () => {
  it('keeps the path as-is', () => {
    expect(trackedUrl('/t/17/b/3', '')).toBe('/t/17/b/3');
  });

  it('keeps ?term=, the one param worth measuring', () => {
    expect(trackedUrl('/glossary', '?term=finesse')).toBe('/glossary?term=finesse');
  });

  it('drops every other param rather than enumerating them', () => {
    expect(trackedUrl('/', '?utm_source=x&code=secret')).toBe('/');
    expect(trackedUrl('/glossary', '?term=squeeze&code=secret')).toBe('/glossary?term=squeeze');
  });

  it('escapes the term', () => {
    expect(trackedUrl('/glossary', '?term=a b&c')).toBe('/glossary?term=a%20b');
  });
});

describe('useAnalytics', () => {
  it('loads matomo.js once and reports the first view without a referrer', () => {
    const { rerender } = renderHook(
      (props: { pathname: string }) => useAnalytics({ enabled: true, search: '', ...props }),
      { initialProps: { pathname: '/glossary' } },
    );

    expect(injected()).toHaveLength(1);
    expect(methods()).toEqual([
      'setTrackerUrl',
      'setSiteId',
      'disableCookies',
      'setDoNotTrack',
      'enableLinkTracking',
      'setCustomUrl',
      'setDocumentTitle',
      'trackPageView',
      'enableLinkTracking',
    ]);
    expect(commands().find((c) => c[0] === 'setCustomUrl')?.[1]).toBe(`${window.location.origin}/glossary`);

    // A navigation: one more view, this time referred by the page it left, and
    // no second copy of matomo.js.
    window._paq = [];
    rerender({ pathname: '/leaderboard' });
    expect(injected()).toHaveLength(1);
    expect(methods()).toEqual([
      'setReferrerUrl',
      'setCustomUrl',
      'setDocumentTitle',
      'trackPageView',
      'enableLinkTracking',
    ]);
    expect(commands()[0][1]).toBe(`${window.location.origin}/glossary`);
  });

  it('does not re-report a re-render that changed no URL', () => {
    const { rerender } = renderHook(() => useAnalytics({ enabled: true, pathname: '/', search: '' }));
    window._paq = [];
    rerender();
    expect(methods()).toEqual([]);
  });

  it('loads nothing at all while disabled — a preview or the demo app never calls Matomo', () => {
    const { rerender } = renderHook(
      (props: { enabled: boolean }) => useAnalytics({ pathname: '/', search: '', ...props }),
      { initialProps: { enabled: false } },
    );
    expect(injected()).toHaveLength(0);
    expect(methods()).toEqual([]);

    // …and starts reporting on the edge where /api/me confirms it should.
    rerender({ enabled: true });
    expect(injected()).toHaveLength(1);
    expect(methods()).toContain('trackPageView');
  });
});
