import { callDisplay, strainClass } from '../../api';

/** A call rendered with its strain glyph in the suit-triad color. */
export function CallText({ call }: { call: number }) {
  const text = callDisplay(call);
  if (call < 3) return <span>{text}</span>;
  const level = text.slice(0, 1);
  const strain = (call - 3) % 5;
  const glyph = text.slice(1);
  return (
    <span className="num">
      {level}
      <span className={strainClass(strain)}>{glyph}</span>
    </span>
  );
}
