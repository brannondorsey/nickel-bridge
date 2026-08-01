/**
 * Run this file on a production-shaped URL. jsdom's default is localhost,
 * which analytics.ts deliberately refuses to report from — see isTrackableHost.
 *
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://bridge.brannon.online/" }
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Me } from './api';
import { reportsAnalytics, trackedUrl, useAnalytics } from './analytics';

/** Queued gtag commands as plain arrays — the queue holds `arguments` objects. */
const commands = () => (window.dataLayer ?? []).map((row) => Array.from(row as IArguments));
// `command:target` for the readable rows — `gtag('js', new Date())` carries a
// Date rather than a name, so only string targets are appended.
const names = () => commands().map((row) => `${row[0]}:${typeof row[1] === 'string' ? row[1] : ''}`);
const injected = () => document.querySelectorAll('script[data-gtag]');

beforeEach(() => {
  window.dataLayer = [];
  injected().forEach((s) => s.remove());
});

afterEach(() => {
  delete window.dataLayer;
});

describe('reportsAnalytics', () => {
  const me = (over: Partial<Me> = {}): Me => ({ user: null, ...over });

  it('reports on a plain deployment, signed in or not', () => {
    expect(reportsAnalytics(me())).toBe(true);
    expect(reportsAnalytics(me({ googleAuth: true }))).toBe(true);
  });

  it('never reports from the demo app or a PR preview', () => {
    expect(reportsAnalytics(me({ demo: true }))).toBe(false);
    expect(reportsAnalytics(me({ devAuth: true }))).toBe(false);
  });

  it('fails CLOSED on an unresolved /api/me — in flight or failed', () => {
    // api.me() throws on any non-2xx, so App.tsx's `loaded` flips with `me`
    // still null. Reading the flags off null would answer "not demo, not
    // devAuth" and report a preview into the production property.
    expect(reportsAnalytics(null)).toBe(false);
  });
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
  it('loads gtag.js once, configures with send_page_view off, and sends the view itself', () => {
    const { rerender } = renderHook(
      (props: { pathname: string }) => useAnalytics({ enabled: true, search: '', ...props }),
      { initialProps: { pathname: '/glossary' } },
    );

    expect(injected()).toHaveLength(1);
    expect(injected()[0].getAttribute('src')).toContain('googletagmanager.com/gtag/js?id=G-');
    expect(names()).toEqual(['js:', 'config:G-ZTL1SZ7ZKZ', 'event:page_view']);

    // The config must suppress gtag's own load-time page view, or the entry
    // URL is counted twice and every later screen still goes unrecorded.
    const config = commands().find((row) => row[0] === 'config');
    expect(config?.[2]).toMatchObject({ send_page_view: false });

    const view = commands().find((row) => row[1] === 'page_view');
    expect(view?.[2]).toMatchObject({ page_location: `${window.location.origin}/glossary` });
    // First view of a page load: gtag's own document.referrer default is the
    // right answer, so we must not overwrite it.
    expect(view?.[2]).not.toHaveProperty('page_referrer');

    // A navigation: one more view, referred by the page it left, and no second
    // copy of the tag.
    window.dataLayer = [];
    rerender({ pathname: '/leaderboard' });
    expect(injected()).toHaveLength(1);
    expect(names()).toEqual(['event:page_view']);
    expect(commands()[0][2]).toMatchObject({
      page_location: `${window.location.origin}/leaderboard`,
      page_referrer: `${window.location.origin}/glossary`,
    });
  });

  it('does not re-report a re-render that changed no URL', () => {
    const { rerender } = renderHook(() => useAnalytics({ enabled: true, pathname: '/', search: '' }));
    window.dataLayer = [];
    rerender();
    expect(names()).toEqual([]);
  });

  it('loads nothing at all while disabled — a preview or the demo app never calls Google', () => {
    const { rerender } = renderHook(
      (props: { enabled: boolean }) => useAnalytics({ pathname: '/', search: '', ...props }),
      { initialProps: { enabled: false } },
    );
    expect(injected()).toHaveLength(0);
    expect(names()).toEqual([]);

    // …and starts reporting on the edge where /api/me confirms it should.
    rerender({ enabled: true });
    expect(injected()).toHaveLength(1);
    expect(names()).toContain('event:page_view');
  });
});
