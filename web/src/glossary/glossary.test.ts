import { describe, expect, it } from 'vitest';
import deep from './deep.json';
import { segmentProse } from './linkify';
import { filterCore, filterDeep, groupByLetter, letterOf } from './search';
import { TERMS, TERM_BY_SLUG, THEMES } from './terms';

const themeIds = new Set(THEMES.map((t) => t.id));

describe('glossary core data', () => {
  it('has unique kebab-case slugs', () => {
    const seen = new Set<string>();
    for (const t of TERMS) {
      expect(t.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(seen.has(t.slug), `duplicate slug ${t.slug}`).toBe(false);
      seen.add(t.slug);
    }
  });

  it('gives every term at least one valid theme', () => {
    for (const t of TERMS) {
      expect(t.themes.length, `${t.slug} has no themes`).toBeGreaterThan(0);
      for (const th of t.themes) expect(themeIds.has(th), `${t.slug}: unknown theme ${th}`).toBe(true);
    }
  });

  it('only relates terms that exist', () => {
    for (const t of TERMS) {
      for (const r of t.related ?? []) {
        expect(TERM_BY_SLUG.has(r), `${t.slug} relates to missing ${r}`).toBe(true);
      }
    }
  });

  it('is sorted A–Z (digit-led terms first)', () => {
    for (let i = 1; i < TERMS.length; i++) {
      const a = TERMS[i - 1].term;
      const b = TERMS[i].term;
      expect(a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }), `${a} !< ${b}`).toBeLessThan(0);
    }
  });

  it('covers the whole curated sheet', () => {
    expect(TERMS.length).toBe(124);
  });
});

describe('glossary deep reference (generated)', () => {
  it('is a substantial, well-formed ledger', () => {
    expect(deep.entries.length).toBeGreaterThan(500);
    for (const e of deep.entries) {
      expect(e.term.length).toBeGreaterThan(0);
      expect(e.def.length).toBeGreaterThan(5);
    }
  });

  it('never duplicates a core term or alias', () => {
    // mirrors the generator's dedupe so a regenerated file can't silently regress
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/\(.*?\)/g, ' ')
        .replace(/[^a-z0-9♠♥♦♣]+/g, ' ')
        .trim();
    const core = new Set<string>();
    for (const t of TERMS) {
      core.add(normalize(t.term));
      for (const a of t.aliases ?? []) core.add(normalize(a));
    }
    for (const e of deep.entries) {
      expect(core.has(normalize(e.term)), `deep entry duplicates core: ${e.term}`).toBe(false);
    }
  });
});

describe('segmentProse (the linkifier)', () => {
  const linksOf = (text: string, omit?: string) => segmentProse(text, omit).filter((s) => s.slug);

  it('links a known term and leaves surrounding text intact', () => {
    const segs = segmentProse('Take the finesse now.');
    expect(segs.map((s) => s.text).join('')).toBe('Take the finesse now.');
    expect(linksOf('Take the finesse now.')).toEqual([{ text: 'finesse', slug: 'finesse' }]);
  });

  it('prefers the longest match', () => {
    expect(linksOf('A takeout double shows the other suits.').map((s) => s.slug)).toContain('takeout-double');
    // "double" alone is linkify:false, so nothing else should have matched inside it
    expect(linksOf('A takeout double shows the other suits.')).toHaveLength(1);
  });

  it('matches simple plurals back to the singular term', () => {
    expect(linksOf('Two finesses both worked.')[0]).toEqual({ text: 'finesses', slug: 'finesse' });
  });

  it('matches aliases ("trump out" → drawing trumps, "hook" → finesse)', () => {
    expect(linksOf('First trump out, then claim.').map((s) => s.slug)).toContain('drawing-trumps');
    expect(linksOf('Take the hook.').map((s) => s.slug)).toContain('finesse');
  });

  it('respects word boundaries — "3NT" never links the NT alias', () => {
    expect(linksOf('Bid 3NT now.')).toHaveLength(0);
  });

  it('links only the first occurrence of a term per block', () => {
    const links = linksOf('A finesse is a finesse is a finesse.');
    expect(links).toHaveLength(1);
  });

  it('honors linkify:false — ultra-common words never auto-link', () => {
    expect(linksOf('Pass this round; the game is close; bid on.')).toHaveLength(0);
  });

  it('omit suppresses self-linking on a term sheet', () => {
    expect(linksOf('The finesse wins.', 'finesse')).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    expect(linksOf('STAYMAN applies.')[0]?.slug).toBe('stayman');
  });
});

describe('search helpers', () => {
  it('filters by theme', () => {
    const conventions = filterCore(TERMS, { query: '', theme: 'conventions' });
    expect(conventions.some((t) => t.slug === 'stayman')).toBe(true);
    expect(conventions.some((t) => t.slug === 'finesse')).toBe(false);
  });

  it('matches names, aliases, and definitions', () => {
    expect(filterCore(TERMS, { query: 'hook', theme: 'ALL' }).map((t) => t.slug)).toContain('finesse');
    expect(filterCore(TERMS, { query: 'yellow card', theme: 'ALL' }).map((t) => t.slug)).toContain('sayc');
    expect(filterCore(TERMS, { query: 'boss suit', theme: 'ALL' }).map((t) => t.slug)).toContain('trump');
  });

  it('groups by letter with a # bucket for digit-led terms', () => {
    expect(letterOf('1NT opening')).toBe('#');
    const groups = groupByLetter(TERMS);
    expect(groups[0].letter).toBe('#');
    expect(groups[0].terms.map((t) => t.slug)).toContain('1nt-opening');
    expect(groups.find((g) => g.letter === 'F')?.terms.map((t) => t.slug)).toContain('finesse');
  });

  it('filters the deep reference by term and definition', () => {
    const entries = [
      { term: 'Splinter bid', def: 'A double-jump response showing shortness.', anchor: 'splinter' },
      { term: 'Alcatraz coup', def: 'An illegal maneuver.', anchor: 'A' },
    ];
    expect(filterDeep(entries, 'splinter')).toHaveLength(1);
    expect(filterDeep(entries, 'illegal')).toHaveLength(1);
    expect(filterDeep(entries, '')).toHaveLength(2);
  });
});
