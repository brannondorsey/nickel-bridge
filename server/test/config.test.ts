import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicOrigin, parsePublicOrigin } from '../src/config.js';

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
});
