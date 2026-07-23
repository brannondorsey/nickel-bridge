import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { TermSheet } from './TermSheet';

/**
 * Sheet-from-anywhere plumbing: the provider wraps the authed app shell, so
 * any prose rendered through GlossaryProse (bid meanings, grade toasts,
 * receipt captions) can open a term's bottom sheet without leaving the page.
 *
 * The open term lives in the URL — `?term=<slug>` on whatever route you're
 * already on — and every openTerm PUSHES a history entry. That makes the
 * browser back button/swipe unwind a recursive chain of related-term taps one
 * sheet at a time (finesse → tenace → back → finesse), and makes any screen's
 * open sheet shareable. Each pushed entry records its depth in history state,
 * so ✕/scrim/Escape can close the whole chain in one navigate(-depth); a cold
 * load that arrives with ?term= already set has no entries of ours to pop, so
 * close strips the param with a replace instead.
 *
 * The default context is a no-op so components using GlossaryProse still
 * render (linkless in effect) outside the provider, e.g. in unit tests.
 */
export const GlossaryContext = createContext<{ openTerm: (slug: string) => void }>({ openTerm: () => {} });
export const useGlossary = () => useContext(GlossaryContext);

/** How many history entries this sheet chain has pushed (0 = not ours). */
function chainDepth(state: unknown): number {
  return (state as { glossDepth?: number } | null)?.glossDepth ?? 0;
}

export function GlossaryProvider({ children }: { children: ReactNode }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const openSlug = params.get('term');

  const openTerm = useCallback(
    (slug: string) => {
      const next = new URLSearchParams(location.search);
      if (next.get('term') === slug) return;
      next.set('term', slug);
      navigate({ search: `?${next}` }, { state: { glossDepth: chainDepth(location.state) + 1 } });
    },
    [navigate, location.search, location.state],
  );

  const closeTerm = useCallback(() => {
    const depth = chainDepth(location.state);
    if (depth > 0) {
      navigate(-depth);
    } else {
      const next = new URLSearchParams(location.search);
      next.delete('term');
      const rest = next.toString();
      navigate({ search: rest ? `?${rest}` : '' }, { replace: true });
    }
  }, [navigate, location.search, location.state]);

  return (
    <GlossaryContext.Provider value={{ openTerm }}>
      {children}
      {openSlug ? <TermSheet slug={openSlug} onOpenTerm={openTerm} onClose={closeTerm} /> : null}
    </GlossaryContext.Provider>
  );
}
