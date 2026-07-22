/**
 * Pure filter/grouping helpers behind the Glossary page. Search is a plain
 * lowercase substring match over names, aliases, and definitions — the list
 * renders A–Z-grouped even while filtered, so there's no ranking to compute,
 * just membership.
 */
import type { DeepEntry } from './deep';
import type { GlossaryTerm, GlossaryTheme } from './terms';

export function matchesCore(t: GlossaryTerm, q: string): boolean {
  if (!q) return true;
  if (t.term.toLowerCase().includes(q)) return true;
  if (t.aliases?.some((a) => a.toLowerCase().includes(q))) return true;
  return t.def.toLowerCase().includes(q);
}

export function filterCore(
  terms: GlossaryTerm[],
  { query, theme }: { query: string; theme: 'ALL' | GlossaryTheme },
): GlossaryTerm[] {
  const q = query.trim().toLowerCase();
  return terms.filter((t) => (theme === 'ALL' || t.themes.includes(theme)) && matchesCore(t, q));
}

export function filterDeep(deep: DeepEntry[], query: string): DeepEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return deep;
  return deep.filter((e) => e.term.toLowerCase().includes(q) || e.def.toLowerCase().includes(q));
}

/** Scrubber rail order; '#' holds digit-led terms like "1NT opening". */
export const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

export function letterOf(term: string): string {
  const c = term[0]?.toUpperCase() ?? '#';
  return c >= 'A' && c <= 'Z' ? c : '#';
}

/** Group an already-sorted term list into letter sections, in list order. */
export function groupByLetter(terms: GlossaryTerm[]): { letter: string; terms: GlossaryTerm[] }[] {
  const groups: { letter: string; terms: GlossaryTerm[] }[] = [];
  for (const t of terms) {
    const letter = letterOf(t.term);
    const last = groups[groups.length - 1];
    if (last && last.letter === letter) last.terms.push(t);
    else groups.push({ letter, terms: [t] });
  }
  return groups;
}
