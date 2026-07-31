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
 * The shipped rule is simple to say: **any pairing that involves an unproven
 * player carries a smaller K, on BOTH sides.** SELF_K_MULT and OPPONENT_DAMP
 * are equal, which is what makes that true, and the equality is load-bearing
 * rather than tidy — see "zero-sum" below.
 *
 * Getting here required rejecting the textbook answer, so the reasoning is
 * worth keeping. Glicko and Kalman both say an uncertain prior should update
 * FASTER: gain is prior-variance / (prior-variance + measurement-noise), and
 * a brand-new player's 1200 is a nearly worthless prior. USCF encodes the
 * same idea as an elevated K during a provisional window. Every one of those
 * systems would set SELF_K_MULT well above 1.
 *
 * They are all optimizing something this app doesn't have: the accuracy of a
 * rating for a player who KEEPS PLAYING. For one who leaves after a single
 * tournament, convergence is worthless — their K is nothing but a knob
 * controlling how much noise they inject on the way out. Measured on the real
 * history, SELF_K_MULT=2 nearly doubled the rating mass leaving with
 * one-and-done accounts (97 → 185) and doubled the worst single-tournament
 * swing for an established player (45 → 90). It is exactly backwards here.
 *
 * Damping both sides instead (tools/calibrate_elo.mjs, 41 tournaments / 27
 * rated humans, vs. classic Elo):
 *
 *   rating stranded by one-and-done accounts   97 → 40   (-59%)
 *   churn taken by established players in
 *     fields containing one                   249 → 174  (-30%)
 *   worst single-tournament swing              45 → 28   (-38%)
 *   zero-sum drift                             -2 → +1   (unchanged)
 *
 * The cost that was expected and did NOT appear: a slower climb for players
 * who stay. Measured as how far a long-record player still was from their
 * final rating when they left the provisional window, it slightly IMPROVED
 * (64 → 49) — less noise during the window leaves them closer to where they
 * settle. That is measured on only the handful of players with 8+ rated
 * tournaments, so treat it as "no evidence of a penalty" rather than proof
 * of a benefit. It is also cheap here in a way it wouldn't be for a chess
 * federation: the leaderboard already hides a player until TOURNAMENTS rated
 * crossings, so a slow start is invisible anyway.
 *
 * **Zero-sum is preserved, and only because the two dials are equal.** With
 * SELF_K_MULT === OPPONENT_DAMP both players in any pairing carry identical
 * K, so every update is still a pure transfer — nothing is created or
 * destroyed. Splitting them (an earlier version shipped 1 / 0.5) drifts the
 * pool by ~-84 points across 27 players. If you ever set them apart, you are
 * choosing to leave strict conservation behind, which is the trade FIDE/USCF
 * made and the root of their perennial inflation-vs-deflation argument. Do
 * it knowingly.
 *
 * Not done, and worth knowing why: FIDE's actual answer is to award no
 * rating at all until a player has met a game threshold. That would zero the
 * stranded-rating problem outright, but at this app's scale most tournaments
 * would then rate nobody — a field needs two ESTABLISHED humans instead of
 * two humans — so the ladder would barely move. Halving the damage is the
 * right trade for a player base this size.
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
  /** Multiplier on a provisional player's own K. */
  SELF_K_MULT: 0.5,
  /** Multiplier on your K when your OPPONENT is provisional. */
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
