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
 * Calibration (tools/calibrate_k.mjs, 100 boards seed cal-1, mean tricks
 * conceded per board vs an all-true-DD reference; blind = --blind):
 *
 *   tier          config      defense  declarer  |ΔNS score|  ms/decision (trick 1)
 *   expert        K=8 aware     0.53     0.38        82           237
 *   intermediate  K=1 aware     0.89     0.87       116            53
 *   beginner      K=1 blind     0.97     1.07       128            48
 *
 * The ladder is monotone: blindness costs beginner opponents most as
 * declarer (they can't place honors from the auction) and produces the
 * occasional big blowup (worst defensive board: 5 tricks). Partner at the
 * K=8 floor concedes ~0.5-0.6 everywhere. The dial saturates ≈ 0.4 tricks
 * by K=32 while trick-1 latency grows linearly, so higher K buys nothing.
 * Changing these constants changes robot behavior for future boards of
 * in-flight non-perfect tournaments (an invariant-1 comparability break
 * scoped to those tournaments).
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

/**
 * Bidding difficulty: unlike card play, robot bidding (bidder.ts) was
 * historically difficulty-BLIND — every tier bid the model's argmax over
 * SAYC-admissible calls, so even beginner opponents/partner bid at full
 * strength. `topN` softens that: instead of always taking the single
 * highest-probability admissible call, the bidder draws (seeded, so still
 * duplicate-fair) from the top `topN` admissible calls weighted by the
 * model's own probabilities. `topN: 1` is mathematically identical to pure
 * argmax, which is why 'expert' is set to 1 — expert bidding is unchanged
 * from before this table existed.
 *
 * Calibration (tools/calibrate_k.mjs --bid-topn, 60 boards seed cal-2: each
 * board's auction bid once pure and once noisy at the given topN, both played
 * out true-DD both sides to isolate bidding noise's own scoring impact from
 * card-play sampling):
 *
 *   topN  contract-changed %  deviations/auction  |ΔNS score| mean
 *   1            0.0                0.00                0
 *   2           28.3                0.50               79
 *   3           33.3                0.58               86
 *   4           33.3                0.62               87
 *   5           31.7                0.62               79
 *
 * topN=1 is a verified no-op (0% changed — confirms the degenerate-to-argmax
 * claim above). Like the K dial, this one saturates fast: topN=2 already
 * captures most of the effect, and topN=3+ barely moves |ΔNS score| beyond
 * noise. topN: 3/2/1 for beginner/intermediate/expert stacks a meaningful,
 * independent ~80-90 point swing on top of card-play sampling's own
 * concession (see the K table above) without over-investing in a saturated
 * dial.
 */
export const BID_NOISE: Record<SettableDifficulty, { topN: number }> = {
  beginner: { topN: 3 },
  intermediate: { topN: 2 },
  expert: { topN: 1 },
};
