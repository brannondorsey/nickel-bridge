/**
 * Robot card-play difficulty tiers.
 *
 * 'perfect' is the historical behavior and a LEGACY value, not a player-facing
 * tier: true-deal double-dummy play (the robot effectively sees all four
 * hands). Every tournament created before difficulty existed resolves to it
 * via the schema default, which is what keeps their robot play — and the
 * robot-trace fixture and demo scenario recipes — byte-identical. It is not
 * settable through the preference API (DIFFICULTIES excludes it).
 *
 * The three player-facing tiers all use sampled double-dummy (play-mc.ts):
 * each decision samples K layouts of the cards the acting player can't see
 * and plays the card with the best total tricks. The dial saturates quickly —
 * even K=1 concedes only ~1 trick/board vs perfect play, because auction
 * constraints and shown-out voids do a lot of inferring — so the tiers vary
 * both K and what the opponents may infer:
 *
 *   expert        kOpp=8, auction-aware   — a strong club player
 *   intermediate  kOpp=1, auction-aware   — one blind-ish guess per decision
 *   beginner      kOpp=1, auction-BLIND   — ignores the bidding entirely
 *                                           (voids still bind; only novices
 *                                           don't count HCP from the auction)
 *
 * `auctionAware` applies to OPPONENTS only. Robot North — only ever the
 * human's defensive partner (humanControls in server/src/game.ts gives the
 * human every N-S hand when N-S declares) — is always auction-aware and
 * floored at PARTNER_FLOOR, so the partner defends at expert-opponent
 * strength on every tier without being semi-omniscient.
 *
 * Calibration (tools/calibrate_k.mjs, tricks conceded per board vs an
 * all-true-DD reference — see the tool for the current sweep):
 *   K=1 ≈ 0.9 defense / 0.8 declarer, K=8 ≈ 0.6 / 0.35, saturating ≈ 0.4 by
 *   K=32 while trick-1 latency grows linearly. Changing these constants
 *   changes robot behavior for future boards of in-flight non-perfect
 *   tournaments (an invariant-1 comparability break scoped to those
 *   tournaments).
 */
export type Difficulty = 'beginner' | 'intermediate' | 'expert' | 'perfect';

/** The tiers a player may choose; 'perfect' is internal/legacy only. */
export type SettableDifficulty = Exclude<Difficulty, 'perfect'>;

export const DIFFICULTIES: readonly SettableDifficulty[] = ['beginner', 'intermediate', 'expert'];

/** Partner North's minimum K at any sampled tier (= expert-opponent strength). */
export const PARTNER_FLOOR = 8;

export const MC_SAMPLES: Record<
  SettableDifficulty,
  { kOpp: number; kPartner: number; auctionAware: boolean }
> = {
  beginner: { kOpp: 1, kPartner: Math.max(1, PARTNER_FLOOR), auctionAware: false },
  intermediate: { kOpp: 1, kPartner: Math.max(1, PARTNER_FLOOR), auctionAware: true },
  expert: { kOpp: 8, kPartner: Math.max(8, PARTNER_FLOOR), auctionAware: true },
};
