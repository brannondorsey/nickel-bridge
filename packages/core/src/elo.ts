/**
 * Elo updates from a completed tournament.
 *
 * Every pair of participants is treated as a head-to-head match decided by
 * their overall matchpoint percentages (win/draw/loss). Updates are computed
 * from pre-tournament ratings and applied simultaneously.
 */
export const ELO_INITIAL = 1200;
export const ELO_K = 24;

export interface EloResult {
  userId: number;
  before: number;
  after: number;
}

export function eloUpdates(
  participants: { userId: number; rating: number; totalPct: number }[],
  k = ELO_K,
): EloResult[] {
  const n = participants.length;
  const deltas = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = participants[i];
      const b = participants[j];
      const expectedA = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
      const scoreA = a.totalPct > b.totalPct ? 1 : a.totalPct < b.totalPct ? 0 : 0.5;
      const delta = k * (scoreA - expectedA);
      deltas[i] += delta;
      deltas[j] -= delta;
    }
  }
  return participants.map((p, i) => ({
    userId: p.userId,
    before: p.rating,
    after: Math.round(p.rating + deltas[i]),
  }));
}
