import { Fragment } from 'react';
import { suitClass } from '../../api';

const SUIT_INDEX: Record<string, number> = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 };

/** Renders free-form SAYC copy (meaning titles/descriptions/shape promises) with every suit glyph colored in the suit-triad, everything else untouched. */
export function SuitText({ text }: { text: string }) {
  const parts = text.split(/([♠♥♦♣])/);
  return (
    <>
      {parts.map((part, i) => {
        const suit = SUIT_INDEX[part];
        return suit === undefined ? <Fragment key={i}>{part}</Fragment> : <span key={i} className={suitClass(suit)}>{part}</span>;
      })}
    </>
  );
}
