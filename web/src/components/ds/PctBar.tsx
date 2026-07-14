/** Inline ink-on-track percentage bar. */
export function PctBar({ pct, width }: { pct: number; width?: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <span className="pctbar" style={width ? { width } : undefined} aria-hidden="true">
      <span className="pctbar-fill" style={{ right: `${100 - clamped}%` }} />
    </span>
  );
}
