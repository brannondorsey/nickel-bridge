/**
 * Lazy access to the deep reference (web/src/glossary/deep.json — generated
 * by tools/gen_glossary_deep.mjs, don't hand-edit). The dynamic import keeps
 * its ~130KB out of the main bundle: Vite splits it into its own chunk,
 * fetched the first time someone lands on the Glossary page.
 */

export interface DeepEntry {
  term: string;
  /** adapted one-liner (first sentence of the Wikipedia definition) */
  def: string;
  /** fragment on WIKI_ARTICLE_URL ('' = link to the article top) */
  anchor: string;
}

export const WIKI_ARTICLE_URL = 'https://en.wikipedia.org/wiki/Glossary_of_contract_bridge_terms';
export const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';

export function deepEntryUrl(e: DeepEntry): string {
  return e.anchor ? `${WIKI_ARTICLE_URL}#${e.anchor}` : WIKI_ARTICLE_URL;
}

let cache: Promise<DeepEntry[]> | null = null;

export function loadDeep(): Promise<DeepEntry[]> {
  if (!cache) {
    // Don't memoize a rejected fetch (e.g. a stale tab requesting a chunk
    // hash a newer deploy removed) — clear the cache so the next call can
    // retry instead of leaving the deep reference permanently broken.
    cache = import('./deep.json')
      .then((m) => m.default.entries)
      .catch((err) => {
        cache = null;
        throw err;
      });
  }
  return cache;
}
