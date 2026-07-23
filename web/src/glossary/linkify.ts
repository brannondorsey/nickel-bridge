/**
 * The glossary linkifier — turns core-term mentions in free prose (SAYC
 * meaning copy, grade toasts, receipt captions) into tappable segments.
 *
 * One regex, built lazily once per session, over every linkifiable phrase
 * (term + aliases of each entry not flagged `linkify: false`):
 * - phrases sorted longest-first, so alternation order gives longest-match-
 *   wins for free ("takeout double" beats "double");
 * - a trailing (?:s|es)? absorbs simple plurals ("finesses", "raises"); a
 *   phrase ending in a consonant + "y" swaps in (?:y|ies) instead ("entry"
 *   also matches "entries", "dummy" also matches "dummies");
 * - lookaround boundaries instead of \b, because terms like "1NT opening"
 *   start/end on characters where \b misfires — a match must not touch an
 *   adjacent letter or digit ("3NT" never matches the "nt" alias).
 *
 * segmentProse links only the FIRST occurrence of each term per text block —
 * bid copy repeats its nouns constantly, and a link farm reads worse than no
 * links at all. The other noise dial is data-side: `linkify: false` in
 * terms.ts.
 */
import { TERMS } from './terms';

export interface ProseSegment {
  text: string;
  /** present ⇒ this segment is a tappable glossary link */
  slug?: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let matcher: { re: RegExp; slugByPhrase: Map<string, string> } | null = null;

function getMatcher(): { re: RegExp; slugByPhrase: Map<string, string> } {
  if (matcher) return matcher;
  const slugByPhrase = new Map<string, string>();
  for (const t of TERMS) {
    if (t.linkify === false) continue;
    for (const phrase of [t.term, ...(t.aliases ?? [])]) {
      slugByPhrase.set(phrase.toLowerCase(), t.slug);
    }
  }
  const phrases = [...slugByPhrase.keys()].sort((a, b) => b.length - a.length);
  const alts = phrases.map((p) => {
    if (/[^aeiou]y$/i.test(p)) return escape(p.slice(0, -1)) + '(?:y|ies)';
    return escape(p) + (/s$/.test(p) ? '' : '(?:s|es)?');
  });
  const re = new RegExp(`(?<![a-zA-Z0-9])(?:${alts.join('|')})(?![a-zA-Z0-9])`, 'gi');
  matcher = { re, slugByPhrase };
  return matcher;
}

/** Resolve a matched string back to its slug (undoes the plural suffix). */
function slugForMatch(slugByPhrase: Map<string, string>, match: string): string | undefined {
  const m = match.toLowerCase();
  return (
    slugByPhrase.get(m) ??
    slugByPhrase.get(m.replace(/ies$/, 'y')) ??
    slugByPhrase.get(m.replace(/es$/, '')) ??
    slugByPhrase.get(m.replace(/s$/, ''))
  );
}

/**
 * Split prose into plain/link segments. `omit` suppresses one slug (a term's
 * own sheet shouldn't link the term to itself).
 */
export function segmentProse(text: string, omit?: string): ProseSegment[] {
  const { re, slugByPhrase } = getMatcher();
  const out: ProseSegment[] = [];
  const seen = new Set<string>();
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const slug = slugForMatch(slugByPhrase, m[0]);
    if (!slug || slug === omit || seen.has(slug)) continue;
    seen.add(slug);
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], slug });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}
