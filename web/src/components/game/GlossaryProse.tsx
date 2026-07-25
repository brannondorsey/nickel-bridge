import { Fragment } from 'react';
import { useGlossary } from '../../glossary/GlossaryContext';
import { LinkPolicy, segmentProse } from '../../glossary/linkify';
import { SuitText } from './SuitText';

/**
 * SuitText plus the glossary linkifier: renders free-form bridge prose with
 * suit glyphs colored AND core glossary terms tappable (dotted underline →
 * term bottom sheet). Term matching runs first, glyph coloring inside each
 * segment — glyphs never span a term boundary, so the order is safe. The
 * LinkPolicy props are pass-through: `omit` keeps a term's own sheet from
 * linking to itself, `force`/`skip` let a teaching surface link differently
 * from gameplay prose (see linkify.ts).
 */
export function GlossaryProse({ text, omit, force, skip }: { text: string } & LinkPolicy) {
  const { openTerm } = useGlossary();
  return (
    <>
      {segmentProse(text, { omit, force, skip }).map((seg, i) =>
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
