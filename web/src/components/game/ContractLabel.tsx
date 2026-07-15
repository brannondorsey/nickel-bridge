import { strainClass } from '../../api';

const STRAIN_INDEX: Record<string, number> = { '♣': 0, '♦': 1, '♥': 2, '♠': 3, NT: 4 };
const LABEL_RE = /^(\d+)(♣|♦|♥|♠|NT)(.*)$/;

/** A contract label (e.g. "3♠X by S +1", from @bridge/core's contractLabel) rendered with its strain glyph in the suit-triad color, matching CallText. */
export function ContractLabel({ label }: { label: string }) {
  const m = LABEL_RE.exec(label);
  if (!m) return <>{label}</>;
  const [, level, strain, rest] = m;
  return (
    <span className="num">
      {level}
      <span className={strainClass(STRAIN_INDEX[strain])}>{strain}</span>
      {rest}
    </span>
  );
}
