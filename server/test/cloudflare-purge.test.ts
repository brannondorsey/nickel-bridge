/**
 * The purge decision in scripts/cloudflare.mjs, which is pure and worth pinning.
 *
 * It earns a test because both of its failure modes are SILENT. Under-purging serves a
 * prerendered page referencing asset filenames the new build deleted — and origin answers a
 * deleted asset with the SPA fallback at 200, so nothing 404s to give it away — for up to the
 * full month-long edge TTL. Over-purging just costs cold fills. So every "cannot tell" case
 * below must resolve to purging everything, and the mixed case must purge BOTH halves.
 *
 * The mixed case is the one that already regressed once: samplePaths() lists the HTML samples
 * before the static files, and an early return on the first differing HTML sample dropped every
 * static file after it. That is the common "add an indexable route" deploy — editing seo.ts's
 * flags changes the prerendered pages and the runtime-generated robots.txt together.
 */
import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { changedPaths, samplePaths, purgeUrls, STATIC_FILES } = await import(resolve(root, 'scripts/cloudflare.mjs'));

const SITE = { host: 'demo-bridge.brannon.online', app: 'nickel-bridge-demo' };
/**
 * Imported rather than re-listed. This was a hand-kept copy, and it drifted the
 * first time STATIC_FILES grew (the home-screen icon set): the arithmetic below
 * is `allPaths.length - STATIC.length`, so a stale copy fails these two cases
 * with an off-by-N that says nothing about what actually changed. The literal
 * beneath it keeps the part that IS a second opinion — that the crawler surface
 * is in the list at all — without pinning a length nobody maintains.
 */
const STATIC: string[] = STATIC_FILES;

const sample: string[] = samplePaths();
const allPaths: string[] = purgeUrls([SITE.host]).map((u: string) => new URL(u).pathname);

/** A snapshot in which every sampled path hashes to a stable placeholder. */
function snapshot(overrides: Record<string, string | null> = {}) {
  const hashes: Record<string, string | null> = {};
  for (const p of sample) hashes[p] = `hash-${p}`;
  return { version: 1, paths: sample, sites: { [SITE.host]: { ...hashes, ...overrides } } };
}
const unchanged = () => Object.fromEntries(sample.map((p) => [p, `hash-${p}`]));

const decide = (before: unknown, after: Record<string, string | null>) =>
  changedPaths(SITE, before, allPaths, after, sample);

describe('purge decision', () => {
  it('treats the crawler surface as individually-purgeable static files', () => {
    // The four that motivated splitting static from HTML in the first place: a
    // crawl visit fetches these and nothing else, and each moves independently
    // of the build, so each has to purge on its own rather than with the pages.
    for (const p of ['/robots.txt', '/sitemap.xml', '/og-image.png', '/favicon.svg']) {
      expect(STATIC).toContain(p);
    }
    expect(sample.filter((p) => STATIC.includes(p))).toEqual(STATIC);
  });

  it('purges nothing when the deploy changed no cached output', () => {
    expect(decide(snapshot(), unchanged())).toEqual([]);
  });

  it('expands any HTML sample into the whole prerendered set, and no static files', () => {
    const got: string[] = decide(snapshot(), { ...unchanged(), '/': 'moved' });
    expect(got).toHaveLength(allPaths.length - STATIC.length);
    expect(got).toContain('/glossary');
    expect(got).toContain('/index.html');
    for (const s of STATIC) expect(got).not.toContain(s);
  });

  it('purges a changed static file on its own', () => {
    expect(decide(snapshot(), { ...unchanged(), '/robots.txt': 'moved' })).toEqual(['/robots.txt']);
  });

  // The regression: HTML samples come first in samplePaths(), so returning early on the first
  // differing one silently dropped robots.txt/sitemap.xml from the same deploy.
  it('purges BOTH halves when a deploy changes the pages and a static file together', () => {
    const got: string[] = decide(snapshot(), {
      ...unchanged(),
      '/': 'moved',
      '/robots.txt': 'moved',
      '/sitemap.xml': 'moved',
    });
    expect(got).toContain('/robots.txt');
    expect(got).toContain('/sitemap.xml');
    expect(got).toContain('/glossary');
    expect(got).toHaveLength(allPaths.length - STATIC.length + 2);
  });

  it('treats an unreadable read on either side as changed, not as unchanged', () => {
    expect(decide(snapshot(), { ...unchanged(), '/favicon.svg': null })).toEqual(['/favicon.svg']);
    expect(decide(snapshot({ '/favicon.svg': null }), unchanged())).toEqual(['/favicon.svg']);
  });

  it('gives up (null = purge everything) on an unusable snapshot', () => {
    expect(decide(null, unchanged())).toBeNull();
    expect(decide({ ...snapshot(), version: 2 }, unchanged())).toBeNull();
    expect(decide({ version: 1, paths: sample, sites: {} }, unchanged())).toBeNull();
  });

  it('gives up when the snapshot was taken against a different sample set', () => {
    const stale = snapshot();
    stale.paths = sample.slice(0, -1); // e.g. terms.ts changed shape since the snapshot
    expect(decide(stale, unchanged())).toBeNull();
  });
});

/**
 * Cloudflare alphabetizes `action_parameters` keys on the way back out, while we author them
 * in reading order. JSON.stringify is key-order sensitive, so --check reported drift on every
 * run even when every value matched — a permanently red weekly job, which is the one outcome
 * the check's own doc comment warns is useless.
 */
describe('rule comparison canonicalization', () => {
  it('ignores key order but preserves array order', async () => {
    const { canonical } = await import(resolve(root, 'scripts/cloudflare.mjs'));
    const live = { browser_ttl: { default: 300, mode: 'override_origin' }, cache: true };
    const desired = { cache: true, browser_ttl: { mode: 'override_origin', default: 300 } };
    expect(JSON.stringify(canonical(live))).toBe(JSON.stringify(canonical(desired)));
    // Order IS significant for rules and status_code_ttl, so arrays must not be sorted — even
    // though the objects inside them ARE. The first element has keys worth sorting so both
    // behaviours are pinned at once, and the values are chosen so that sorting the array WOULD
    // move {a:2} to the front — otherwise the assertion passes either way. Compared as a string
    // because toEqual ignores the very key order this function exists to normalize.
    expect(JSON.stringify(canonical([{ z: 1, m: 0 }, { a: 2 }]))).toBe('[{"m":0,"z":1},{"a":2}]');
    // Real differences must still be caught.
    expect(JSON.stringify(canonical({ cache: true }))).not.toBe(JSON.stringify(canonical({ cache: false })));
  });
});
