/**
 * Elo updates from a completed tournament.
 *
 * Every pair of participants is treated as a head-to-head match decided by
 * their overall matchpoint percentages (win/draw/loss). Updates are computed
 * from pre-tournament ratings and applied simultaneously.
 *
 * The one departure from textbook Elo is that K is **per participant, per
 * pairing** rather than one shared constant — see PROVISIONAL below for why.
 */
export const ELO_INITIAL = 1200;
export const ELO_K = 24;

/**
 * Provisional ratings: the two dials that stop a player's first few crossings
 * from being treated as settled fact.
 *
 * The problem this exists for is specific and was measured, not imagined. A
 * new account starts at ELO_INITIAL, gets placed into a small evergreen field,
 * and can win or lose real rating on four boards of variance — and because
 * `recomputeElo` replays history forever, that transfer is permanent even if
 * the account never returns. On the production database at the time this was
 * written, 7 of the 16 humans who had ever been rated had exactly ONE rated
 * tournament and had already gone quiet; single-tournament swings among them
 * ran from -38 to +34, and one established player dropped 45 points in a
 * single crossing (deltas stack across every pairing in the field, so a small
 * field does NOT bound the damage to ±K the way a 1v1 game would).
 *
 * There are two candidate dials here, and **only one of them survived
 * measurement**. The distinction is between the USCF/FIDE fix and the Glicko
 * one, and it matters which problem each actually solves:
 *
 * - OPPONENT_DAMP (Glicko's rating-deviation insight): a result against an
 *   unproven player is weak evidence about *you*, so it should move your
 *   rating less. This is the shipped dial, and the only one that helps here.
 *
 * - SELF_K_MULT (the USCF provisional window): an unproven player's OWN
 *   rating moves faster so it converges to their true strength in a few
 *   crossings. **Ships INERT (1) — measurement showed it makes this specific
 *   problem worse, not better.** An elevated K only pays off for a player who
 *   keeps playing; for one who leaves after a single tournament it just
 *   amplifies the noise they inject and then walk away holding. On the real
 *   history, SELF_K_MULT=2 alone took the rating mass leaving with
 *   one-and-done accounts from 97 to 185, and the worst single-tournament
 *   swing for an established player from 45 points to 90. It is kept as a
 *   dial (not deleted) because it would be the right lever if the population
 *   ever shifts toward newcomers who stay — but turn it on only with a fresh
 *   sweep, the same way PLAY_NOISE ships off for `intermediate`.
 *
 * Measured effect of the shipped values on the real history
 * (tools/calibrate_elo.mjs, 41 tournaments / 27 rated humans):
 * summed rating churn taken by established players in fields containing a
 * one-and-done account fell 249 → 193 (-22%), the worst single-tournament
 * swing 45 → 33 (-27%), and rating mass walking out the door 97 → 80 (-18%).
 * The existing ladder did not reorder at all (zero rank swaps).
 *
 * The cost, stated plainly rather than hidden: unequal K on the two sides of
 * a pairing means rating is **no longer strictly zero-sum**. The pool drifts
 * about -84 points total across 27 players (~3 points each) — established
 * players win less from beating a newcomer than the newcomer loses, and they
 * beat newcomers more often than not. That is the same trade every
 * provisional-rating system in wide use has made, and it is the root of the
 * perennial FIDE/USCF inflation-vs-deflation argument. Re-run the sweep
 * before touching these numbers.
 *
 * TOURNAMENTS deliberately matches the leaderboard's own provisional quota
 * (PROVISIONAL_MIN_TOURNAMENTS in server/src/tournaments.ts). That quota
 * already decides when the app is willing to *show* a rating; this decides
 * when it is willing to *trust* one. Keeping them equal means there is one
 * answer to "when does a player count as established" rather than two.
 */
export const PROVISIONAL = {
  /** Rated tournaments before a player counts as established. */
  TOURNAMENTS: 4,
  /** Multiplier on a provisional player's own K. 1 = off — see above. */
  SELF_K_MULT: 1,
  /** Multiplier on your K when your OPPONENT is provisional — trust it less. */
  OPPONENT_DAMP: 0.5,
} as const;

export type ProvisionalConfig = {
  TOURNAMENTS: number;
  SELF_K_MULT: number;
  OPPONENT_DAMP: number;
};

export interface EloParticipant {
  userId: number;
  rating: number;
  totalPct: number;
  /**
   * Rated tournaments this player finished BEFORE this one. Omitting it means
   * "established", which keeps every caller that doesn't track history (tests,
   * one-off scoring) on exactly the classic single-K behavior.
   */
  priorTournaments?: number;
}

export interface EloResult {
  userId: number;
  before: number;
  after: number;
}

export interface EloOptions {
  k?: number;
  /** Pass null for pure classic Elo — one shared K, strictly zero-sum. */
  provisional?: ProvisionalConfig | null;
}

export function eloUpdates(participants: EloParticipant[], opts: EloOptions = {}): EloResult[] {
  const k = opts.k ?? ELO_K;
  const prov = opts.provisional === undefined ? PROVISIONAL : opts.provisional;
  const isProvisional = (p: EloParticipant) =>
    prov !== null && (p.priorTournaments ?? Infinity) < prov.TOURNAMENTS;

  const n = participants.length;
  const deltas = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = participants[i];
      const b = participants[j];
      const expectedA = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
      const scoreA = a.totalPct > b.totalPct ? 1 : a.totalPct < b.totalPct ? 0 : 0.5;
      // The surprise is shared and symmetric; only the K each side carries
      // differs, so with no provisional players this is identical to a single
      // K applied with opposite signs — the classic formula, unchanged.
      const surprise = scoreA - expectedA;
      const kA = kFor(a, b, k, prov, isProvisional);
      const kB = kFor(b, a, k, prov, isProvisional);
      deltas[i] += kA * surprise;
      deltas[j] -= kB * surprise;
    }
  }
  return participants.map((p, i) => ({
    userId: p.userId,
    before: p.rating,
    after: Math.round(p.rating + deltas[i]),
  }));
}

/** Effective K for `self` in a pairing against `opponent`. */
function kFor(
  self: EloParticipant,
  opponent: EloParticipant,
  k: number,
  prov: ProvisionalConfig | null,
  isProvisional: (p: EloParticipant) => boolean,
): number {
  if (prov === null) return k;
  let effective = k;
  if (isProvisional(self)) effective *= prov.SELF_K_MULT;
  if (isProvisional(opponent)) effective *= prov.OPPONENT_DAMP;
  return effective;
}
