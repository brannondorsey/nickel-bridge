/**
 * The Cards Were Worth rail — layout math for the field-scores scatter with
 * par as the dashed gate ("The Receipt and the Rail"). Pure and DOM-free so
 * the geometry is unit-testable beside the screen that draws it, the
 * activityFeed.ts precedent.
 *
 * Positions are LINEAR in the score with a minimum-gap relaxation, not a log
 * scale — a decision that was measured, not assumed. A signed log
 * (sign(s)·ln(1+|s|/100)) handles the sign change and pulls a −1100 doubled
 * disaster into frame, but bridge fields usually cluster at game scores
 * (±420–660), far from zero where a log is at its flattest: for a field of
 * {−1100, 620, 650} it SHRINKS the readable 620–650 gap from 1.7% of the
 * axis to 0.9%, compressing exactly the differences the rail exists to show.
 * The relaxation instead keeps every position honestly linear until two dots
 * would collide, then pushes only those apart (order-preserving sweeps,
 * clamped to the frame) — distortion happens locally where it is needed,
 * never globally. The receipts above the rail carry the exact figures, so
 * nothing depends on reading a distance precisely. Higher scores for YOUR
 * side sit further right, the app's usual direction encoding.
 *
 * The gate stays at par's un-relaxed linear position: a crowded field can
 * therefore drift a dot slightly past it, which is accepted — the gate is a
 * reference line, and every dot label carries its true score.
 */

export interface RailDotInput {
  score: number;
  contract: string;
  you: boolean;
}

export interface RailDot {
  /** 0..1 position along the axis, clamped so centred labels stay in frame */
  x: number;
  score: number;
  /** distinct contracts that landed on this score, in field order */
  contracts: string[];
  /** how many tables share the score */
  count: number;
  you: boolean;
  /** label above the axis (true) or below (false) — alternated along the rail
   *  so near-tie neighbours never share a band */
  up: boolean;
}

export interface RailLayout {
  /** par's 0..1 position (the dashed gate) */
  gate: number;
  dots: RailDot[];
  /** tables whose scores were sampled out of a crowded rail — counted, never
   *  silently dropped (the ledger's setAside precedent) */
  omittedTables: number;
}

/** clamp band so dots and their centred labels stay inside the frame */
const EDGE = 0.07;
/** adjacent dots never sit closer than this; label bands alternate, so
 *  same-band neighbours (two apart) get at least double — enough for the
 *  contract line at the rail's label size */
const MIN_GAP = 0.08;
/**
 * A crowded field is SAMPLED down to this many dots rather than squeezed:
 * below the min-gap the labels collide, and shrinking the gap further turns
 * the rail into the smear it exists to avoid. Selection keeps YOU, the min
 * and the max (so the axis span never lies), then the most-populated scores
 * — the field's modes — and counts what it leaves out. Eight dots at full
 * MIN_GAP still fit the frame (7 × 0.08 < 0.86).
 */
export const MAX_RAIL_DOTS = 8;

export function railLayout(field: RailDotInput[], parScore: number): RailLayout {
  // tables sharing a score merge into one dot — stacked dots are unreadable,
  // and a shared score IS one result as far as matchpoints care
  const byScore = new Map<number, { contracts: string[]; count: number; you: boolean }>();
  for (const f of field) {
    const m = byScore.get(f.score) ?? { contracts: [], count: 0, you: false };
    if (!m.contracts.includes(f.contract)) m.contracts.push(f.contract);
    m.count += 1;
    m.you = m.you || f.you;
    byScore.set(f.score, m);
  }

  // sample a crowded rail down to the dot budget: YOU + the extremes are
  // non-negotiable, the rest go by table count (the modes), and the omitted
  // tables are counted for the caption
  let entries = [...byScore.entries()].sort((a, b) => a[0] - b[0]);
  let omittedTables = 0;
  if (entries.length > MAX_RAIL_DOTS) {
    const keep = new Set<number>([entries[0][0], entries[entries.length - 1][0]]);
    const yours = entries.find(([, m]) => m.you);
    if (yours) keep.add(yours[0]);
    const byCount = [...entries].sort((a, b) => b[1].count - a[1].count || a[0] - b[0]);
    for (const [score] of byCount) {
      if (keep.size >= MAX_RAIL_DOTS) break;
      keep.add(score);
    }
    omittedTables = entries.filter(([s]) => !keep.has(s)).reduce((n, [, m]) => n + m.count, 0);
    entries = entries.filter(([s]) => keep.has(s));
  }

  const scores = entries.map(([s]) => s);
  const lo = Math.min(...scores, parScore);
  const span = Math.max(...scores, parScore) - lo;
  const usable = 1 - 2 * EDGE;
  const pos = (score: number) => (span === 0 ? 0.5 : EDGE + ((score - lo) / span) * usable);

  // order-preserving relaxation: push right, pull back into frame, floor at
  // the left edge — the clamped gap guarantees the result fits
  const xs = scores.map(pos);
  const gap = scores.length > 1 ? Math.min(MIN_GAP, usable / (scores.length - 1)) : 0;
  for (let i = 1; i < xs.length; i++) xs[i] = Math.max(xs[i], xs[i - 1] + gap);
  xs[xs.length - 1] = Math.min(xs[xs.length - 1], 1 - EDGE);
  for (let i = xs.length - 2; i >= 0; i--) xs[i] = Math.min(xs[i], xs[i + 1] - gap);
  xs[0] = Math.max(xs[0], EDGE);
  for (let i = 1; i < xs.length; i++) xs[i] = Math.max(xs[i], xs[i - 1] + gap);

  const dots = scores.map((score, i) => ({ score, x: xs[i], ...byScore.get(score)!, up: i % 2 === 1 }));
  return { gate: pos(parScore), dots, omittedTables };
}
