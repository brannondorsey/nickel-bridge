/**
 * The two decisions in scripts/cloudflare.mjs's `--audit` that once turned the weekly
 * edge-upkeep job red for reasons that were not real faults.
 *
 * - A paused host is skipped. The demo app's deploy job is switched off, so its host serves
 *   525 and its cert has lapsed; auditing it failed every run from 2026-10-19 on, and a check
 *   that is always red hides the host that is live. The flag is only right while it agrees with
 *   ci.yml's gate, so that agreement is pinned here, read out of the workflow file itself the way
 *   web/src/seo.test.ts reads App.tsx's routes.
 * - Cert expiry is read from the NEWEST certificate. Fly keeps listing a replaced cert until it
 *   expires, and reading the soonest entry reported a renewed production cert as unrenewed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { SITES, certDaysLeft } = await import(resolve(root, 'scripts/cloudflare.mjs'));

/** The `if:` of one job in ci.yml: the first `if:` line after `  <job>:`, before the next job. */
function jobIf(job: string): string {
  const lines = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) throw new Error(`no ${job} job in ci.yml`);
  for (const l of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(l)) break; // the next job
    const m = l.match(/^ {4}if:\s*(.*)$/);
    if (m) return m[1];
  }
  throw new Error(`${job} has no if:`);
}

describe('paused hosts', () => {
  it("demo is paused exactly while ci.yml's deploy-demo is gated off", () => {
    const demo = SITES.find((s: { app: string }) => s.app === 'nickel-bridge-demo');
    const gatedOff = /^false\s*&&/.test(jobIf('deploy-demo'));
    // Flip one without the other and this names both lines that need to move together.
    expect(
      Boolean(demo.paused),
      'SITES.paused in scripts/cloudflare.mjs must match the `false &&` gate on deploy-demo in ci.yml',
    ).toBe(gatedOff);
  });

  it('never pauses production', () => {
    const prod = SITES.find((s: { app: string }) => s.app === 'nickel-bridge');
    expect(prod.paused).toBeFalsy();
  });
});

describe('certDaysLeft', () => {
  const now = Date.parse('2026-11-23T00:00:00Z');
  const day = (n: number) => new Date(now + n * 86_400_000 + 3_600_000).toISOString();

  it('reads the renewed certificate, not the replaced one Fly still lists', () => {
    // Production's real shape the week after it renewed.
    const nodes = [
      { type: 'rsa', expiresAt: day(79) },
      { type: 'ecdsa', expiresAt: day(79) },
      { type: 'rsa', expiresAt: day(19) },
      { type: 'ecdsa', expiresAt: day(19) },
    ];
    expect(certDaysLeft(nodes, now)).toBe(79);
  });

  it('does not let one key type renewing hide the other failing to', () => {
    const nodes = [
      { type: 'rsa', expiresAt: day(79) },
      { type: 'rsa', expiresAt: day(19) },
      { type: 'ecdsa', expiresAt: day(19) },
    ];
    expect(certDaysLeft(nodes, now)).toBe(19);
  });

  it('is null when nothing is issued', () => {
    expect(certDaysLeft([], now)).toBeNull();
  });
});
