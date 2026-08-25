import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicOrigin, canonicalHost, parsePublicOrigin } from '../src/config.js';

/**
 * BASE_URL parsing. `parsePublicOrigin` is pure, so these need no env
 * juggling; only the boot assertion reads process.env, and it's exercised
 * through explicit set/unset.
 */
describe('parsePublicOrigin', () => {
  it('accepts an absolute http(s) origin and normalizes it', () => {
    expect(parsePublicOrigin('https://bridge.brannon.online')).toBe('https://bridge.brannon.online');
    expect(parsePublicOrigin('https://bridge.brannon.online/')).toBe('https://bridge.brannon.online');
    expect(parsePublicOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    // a path on the base url is not part of the origin
    expect(parsePublicOrigin('https://example.com/app/')).toBe('https://example.com');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    // Vite's own BASE_URL (its public base path), which Vitest puts on
    // process.env — the value that made all three old parsers misbehave.
    ["Vite's base path", '/'],
    // docker-compose.yml builds BASE_URL as https://${DOMAIN}; an unset DOMAIN
    // collapses to this, which the old .startsWith('https') cookie check passed.
    ['a scheme with no host', 'https://'],
    ['a bare hostname', 'bridge.brannon.online'],
    ['a non-web protocol', 'ftp://bridge.brannon.online'],
  ])('rejects %s', (_label, raw) => {
    expect(parsePublicOrigin(raw)).toBeNull();
  });
});

/**
 * The host half of BASE_URL, which auth.ts uses to keep the OAuth state
 * cookie and the redirect_uri on one origin. Null when BASE_URL names no
 * origin is the load-bearing case: PUBLIC_ORIGIN falls back to the dev origin
 * there, and a canonical host derived from that fallback would tell every
 * visitor of an unconfigured deployment to go to localhost.
 */
describe('canonicalHost', () => {
  it('is the host of the configured origin, port included', () => {
    expect(canonicalHost('https://bridge.brannon.online')).toBe('bridge.brannon.online');
    expect(canonicalHost('https://bridge.brannon.online/ignored/path')).toBe('bridge.brannon.online');
    expect(canonicalHost('http://localhost:3000')).toBe('localhost:3000');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ["Vite's base path", '/'],
    ['a scheme with no host', 'https://'],
    ['a bare hostname', 'bridge.brannon.online'],
  ])('is null when BASE_URL is %s, so nothing redirects anywhere', (_label, raw) => {
    expect(canonicalHost(raw)).toBeNull();
  });
});

describe('assertPublicOrigin', () => {
  const original = process.env.BASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = original;
  });

  it('throws on a BASE_URL that is set but unusable, naming the value', () => {
    process.env.BASE_URL = 'https://';
    const log = { warn: vi.fn() };
    expect(() => assertPublicOrigin(log)).toThrow(/BASE_URL is set to "https:\/\/"/);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('passes silently on a valid BASE_URL', () => {
    process.env.BASE_URL = 'https://bridge.brannon.online';
    const log = { warn: vi.fn() };
    expect(() => assertPublicOrigin(log)).not.toThrow();
    expect(log.warn).not.toHaveBeenCalled();
  });

  // Unset is the documented local-dev shape (DEV_AUTH=1 npm run dev), so this
  // must not be fatal — but it does mean non-Secure cookies, which is worth
  // saying out loud.
  it('warns but does not throw when BASE_URL is unset', () => {
    delete process.env.BASE_URL;
    const log = { warn: vi.fn() };
    expect(() => assertPublicOrigin(log)).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('NOT be marked Secure'));
  });

  // Deliberate, and pinned here because it's the one case where "invalid" and
  // "absent" could each be argued: an empty value is what tooling forwards for
  // an unset one, so it takes the warn path rather than the throw path.
  it('treats an explicitly empty BASE_URL as absent rather than broken', () => {
    process.env.BASE_URL = '';
    const log = { warn: vi.fn() };
    expect(() => assertPublicOrigin(log)).not.toThrow();
    expect(log.warn).toHaveBeenCalled();
  });
});
