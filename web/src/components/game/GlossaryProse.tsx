import { Fragment } from 'react';
import { useGlossary } from '../../glossary/GlossaryContext';
import { segmentProse } from '../../glossary/linkify';
import { SuitText } from './SuitText';

/**
 * SuitText plus the glossary linkifier: renders free-form bridge prose with
 * suit glyphs colored AND core glossary terms tappable (dotted underline →
 * term bottom sheet). Term matching runs first, glyph coloring inside each
 * segment — glyphs never span a term boundary, so the order is safe. `omit`
 * keeps a term's own sheet from linking to itself.
 */
export function GlossaryProse({ text, omit }: { text: string; omit?: string }) {
  const { openTerm } = useGlossary();
  return (
    <>
      {segmentProse(text, omit).map((seg, i) =>
        seg.slug ? (
          <button key={i} type="button" className="gloss-link" onClick={() => openTerm(seg.slug!)}>
            <SuitText text={seg.text} />
          </button>
        ) : (
          <Fragment key={i}>
            <SuitText text={seg.text} />
          </Fragment>
        ),
      )}
    </>
  );
}
