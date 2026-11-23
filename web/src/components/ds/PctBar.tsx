/** Inline ink-on-track percentage bar. `className` composes an extra class
 *  onto the track (e.g. a caller that wants it to flex-fill a row rather than
 *  sit at the default fixed width) without touching the base `.pctbar` rule
 *  every other caller relies on. */
export function PctBar({ pct, width, className }: { pct: number; width?: number; className?: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <span className={`pctbar${className ? ` ${className}` : ''}`} style={width ? { width } : undefined} aria-hidden="true">
      <span className="pctbar-fill" style={{ right: `${100 - clamped}%` }} />
    </span>
  );
}
