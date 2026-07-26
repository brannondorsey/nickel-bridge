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
 *
 * That sitewide flag is tuned for GAMEPLAY prose, where "trick"/"trump"/"game"
 * appear in every other sentence. A teaching surface can override it per call
 * with a LinkPolicy (see the first-crossing tour's TOUR_LINKS): `force` links
 * a handful of those common words anyway — they're the whole point of the
 * lesson to someone meeting them for the first time — and `skip` drops a term
 * the matcher reads in the wrong sense for that copy.
 */
import { TERMS } from './terms';

export interface ProseSegment {
  text: string;
  /** present ⇒ this segment is a tappable glossary link */
  slug?: string;
}

/** How one surface links (or doesn't) — see the module comment. */
export interface LinkPolicy {
  /** suppress one slug: a term's own sheet shouldn't link the term to itself */
  omit?: string;
  /** link these slugs even though terms.ts marks them `linkify: false` */
  force?: readonly string[];
  /** never link these slugs here, whatever the matcher finds */
  skip?: readonly string[];
}

interface Matcher {
  re: RegExp;
  slugByPhrase: Map<string, string>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Keyed by the force set (the empty key is the sitewide matcher, built exactly
// as it was before policies existed — `force` can only ever ADD phrases, so no
// policy can change how another surface reads).
const matchers = new Map<string, Matcher>();

function getMatcher(force?: readonly string[]): Matcher {
  const forced = new Set(force ?? []);
  const key = [...forced].sort().join('|');
  const cached = matchers.get(key);
  if (cached) return cached;
  const slugByPhrase = new Map<string, string>();
  for (const t of TERMS) {
    if (t.linkify === false && !forced.has(t.slug)) continue;
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
  const built = { re, slugByPhrase };
  matchers.set(key, built);
  return built;
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

/** Split prose into plain/link segments under a surface's LinkPolicy. */
export function segmentProse(text: string, policy: LinkPolicy = {}): ProseSegment[] {
  const { re, slugByPhrase } = getMatcher(policy.force);
  const skip = policy.skip ? new Set(policy.skip) : null;
  const out: ProseSegment[] = [];
  const seen = new Set<string>();
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const slug = slugForMatch(slugByPhrase, m[0]);
    if (!slug || slug === policy.omit || skip?.has(slug) || seen.has(slug)) continue;
    seen.add(slug);
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], slug });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}
