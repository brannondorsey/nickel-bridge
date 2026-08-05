import { MedalSuit } from '../../api';

const SUIT_GLYPH: Record<MedalSuit, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };
const SUIT_CLASS: Record<MedalSuit, string> = { c: 'suit-c', d: 'suit-d', h: 'suit-h', s: 'suit-s' };
const ALL_SUITS: MedalSuit[] = ['c', 'd', 'h', 's'];

/**
 * The suit-medal row, shared between two contexts:
 * - `mode="all"` (Home's rail): always all four, close together, colored
 *   once earned — reusing the app's existing suit-color classes verbatim
 *   (`suitClass` in api.ts, `SuitText.tsx`'s pattern), so night mode and the
 *   colorblind palette need no extra work. Not-yet-earned marks use
 *   `medal-glyph-locked` (`var(--line)`), the exact "muted sibling" idiom
 *   `StarGrade.tsx` already uses for "earned in real color, rest muted."
 * - `mode="earnedOnly"` (the profile trophy case): only what's actually
 *   been won renders — no locked placeholders, no box, no caption. Renders
 *   nothing at all if nothing has been earned yet.
 */
export function MedalGlyphs({
  earned,
  mode,
  className = '',
}: {
  earned: MedalSuit[];
  mode: 'all' | 'earnedOnly';
  className?: string;
}) {
  if (mode === 'earnedOnly' && earned.length === 0) return null;
  const suits = mode === 'all' ? ALL_SUITS : earned;
  return (
    <span className={`medal-glyphs ${className}`.trim()}>
      {suits.map((s) =>
        earned.includes(s) ? (
          <span key={s} className={`medal-glyph ${SUIT_CLASS[s]}`}>
            {SUIT_GLYPH[s]}
          </span>
        ) : (
          <span key={s} className="medal-glyph medal-glyph-locked">
            {SUIT_GLYPH[s]}
          </span>
        ),
      )}
    </span>
  );
}
