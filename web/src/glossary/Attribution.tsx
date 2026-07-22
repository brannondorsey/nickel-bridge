import { LICENSE_URL, WIKI_ARTICLE_URL } from './deep';

/**
 * The CC BY-SA credit the glossary content requires, rendered on the Glossary
 * page footer (`full`) and on every term sheet (compact). One component so
 * the license text can't drift between the two required surfaces.
 */
export function Attribution({ full = false }: { full?: boolean }) {
  return (
    <div className="gloss-attrib">
      Adapted from Wikipedia’s{' '}
      <a href={WIKI_ARTICLE_URL} target="_blank" rel="noopener noreferrer">
        <i>Glossary of contract bridge terms</i>
      </a>{' '}
      ·{' '}
      <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
        CC BY-SA 4.0
      </a>
      {full ? <> — our adapted text is shared under the same license.</> : null}
    </div>
  );
}
