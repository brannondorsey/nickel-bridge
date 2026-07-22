import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { TermSheet } from './TermSheet';

/**
 * Sheet-from-anywhere plumbing: the provider wraps the authed app shell, so
 * any prose rendered through GlossaryProse (bid meanings, grade toasts,
 * receipt captions) can open a term's bottom sheet without navigating. It's
 * the app-wide version of Board's state-driven CallInspector mount. Opening,
 * closing, and related-term swaps are pure state — no history entries, so the
 * back button never has to unwind sheet taps; the /glossary/:slug route seeds
 * this state on mount instead of the other way round.
 *
 * The default context is a no-op so components using GlossaryProse still
 * render (linkless in effect) outside the provider, e.g. in unit tests.
 */
export const GlossaryContext = createContext<{ openTerm: (slug: string) => void }>({ openTerm: () => {} });
export const useGlossary = () => useContext(GlossaryContext);

export function GlossaryProvider({ children }: { children: ReactNode }) {
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const openTerm = useCallback((slug: string) => setOpenSlug(slug), []);
  return (
    <GlossaryContext.Provider value={{ openTerm }}>
      {children}
      {openSlug ? <TermSheet slug={openSlug} onOpenTerm={openTerm} onClose={() => setOpenSlug(null)} /> : null}
    </GlossaryContext.Provider>
  );
}
