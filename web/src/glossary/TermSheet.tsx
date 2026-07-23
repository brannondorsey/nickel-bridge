import { Dialog } from '../components/ds/Dialog';
import { GlossaryProse } from '../components/game/GlossaryProse';
import { SuitText } from '../components/game/SuitText';
import { Attribution } from './Attribution';
import { TERM_BY_SLUG, THEME_CHIP, type GlossaryTerm } from './terms';

/**
 * The term-definition bottom sheet (design "entry sheet"). Mounted globally
 * by GlossaryProvider; RELATED chips call onOpenTerm (GlossaryContext's
 * openTerm), which re-renders this same sheet for the new slug but pushes a
 * history entry for the hop, so a chain of related-term taps unwinds one
 * sheet at a time on back/swipe (see GlossaryContext.tsx). The definition
 * itself renders through GlossaryProse, so terms mentioned inside it are
 * live links too (minus the term itself).
 */
export function TermSheet({
  slug,
  onOpenTerm,
  onClose,
}: {
  slug: string;
  onOpenTerm: (slug: string) => void;
  onClose: () => void;
}) {
  const term = TERM_BY_SLUG.get(slug);
  if (!term) {
    return (
      <Dialog title="Not in the ledger" onClose={onClose}>
        <div className="gloss-def">No entry under that name — try the Glossary’s search.</div>
        <Attribution />
      </Dialog>
    );
  }
  const related = (term.related ?? [])
    .map((s) => TERM_BY_SLUG.get(s))
    .filter((t): t is GlossaryTerm => t !== undefined);
  return (
    <Dialog title={<SuitText text={term.term} />} onClose={onClose}>
      <div className="gloss-badges">
        {term.themes.map((th) => (
          <span key={th} className="gloss-badge">
            {THEME_CHIP[th]}
          </span>
        ))}
      </div>
      {term.aliases?.length ? <div className="gloss-aliases">also searched as: {term.aliases.join(', ')}</div> : null}
      <div className="gloss-def">
        <GlossaryProse text={term.def} omit={term.slug} />
      </div>
      {term.example ? (
        <div className="gloss-example">
          <SuitText text={term.example} />
        </div>
      ) : null}
      {related.length ? (
        <div className="gloss-related">
          <span className="gloss-related-label">RELATED</span>
          {related.map((r) => (
            <button key={r.slug} type="button" className="gloss-related-chip" onClick={() => onOpenTerm(r.slug)}>
              <SuitText text={r.term} />
            </button>
          ))}
        </div>
      ) : null}
      <Attribution />
    </Dialog>
  );
}
