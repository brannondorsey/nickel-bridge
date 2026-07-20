/**
 * Robot card-play difficulty tiers.
 *
 * New to this file? Start with docs/difficulty-tuning-guide.md — it explains
 * the mental model behind MC_SAMPLES/BID_NOISE/PLAY_NOISE as a set, how to
 * measure a change, which tools to use, and the safety checklist for editing
 * any constant here. The doc comments below are the reference/rationale for
 * each specific constant; the guide is the how-to.
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

/**
 * Card-play SELECTION noise: every other mechanism above (K, auctionAware,
 * BID_NOISE) only ever corrupts the acting player's BELIEF about the hidden
 * cards — chooseCardSampled still always plays the single highest-scoring
 * legal card against whatever it sampled (a pure argmax, see pickFromSolve).
 * `playTopN` softens that final DECISION instead: draws (same seeded stream
 * as the rest of the decision, still duplicate-fair) from the top `playTopN`
 * legal cards weighted by the K-sample's own score, instead of always the
 * best one — the same idea BID_NOISE already applies to bidding, applied
 * here to card play. `playTopN: 1` is mathematically identical to the prior
 * argmax-only behavior, which is why 'expert' is set to 1.
 *
 * Research finding (docs/difficulty-calibration-research.md §7c/7d): K is
 * already floored at 1 for beginner/intermediate and BID_NOISE saturates by
 * topN≈3-4, but this dial keeps adding real, well-powered effect through at
 * least topN≈6 — the largest lever found for these tiers — AND, unlike
 * raising K, costs nothing extra at inference time (it re-weights the same
 * per-card totals the K-sample solve already computed).
 *
 * Calibration (tools/calibrate_stats.mjs playtopn, defense-side only, K=1
 * auction-aware, 250 boards seed final-pn; tricks conceded vs a true-DD
 * reference, paired per board against the topN=1 baseline):
 *
 *   topN   tricks conceded   paired Δ vs topN=1
 *   1           0.98               0.012  (confirmed no-op)
 *   2           1.29               0.328
 *   3           1.35               0.384
 *   4           1.42               0.460
 *   6           1.52               0.556
 *   8           1.53               0.568
 *
 * A second, broader measurement (any East/West seat, declaring or
 * defending, signed IMP swing vs a pure/true-DD reference — see the doc's
 * §7c) found continued meaningful gains through topN=3-4 rather than
 * flattening as early as the table above; the two didn't fully agree on the
 * exact saturation shape (likely because the second measurement also
 * captures declarer-seat weakening, the larger of the two roles per the K
 * table above), so treat the precise optimal topN as uncertain by ±1-2, not
 * the existence of the effect.
 *
 * `intermediate` shipped at topN=2 initially, alongside `beginner`'s topN=3,
 * mirroring BID_NOISE's shape. Measurement (§7 continued — see
 * docs/difficulty-calibration-research.md and
 * docs/difficulty-tuning-guide.md) then showed beginner and intermediate
 * landing within noise of each other in the combined (bidding + card play)
 * signed-IMP metric — the tiers' *individual* dials moved monotonically as
 * designed, but not by enough to separate the tiers by a human-noticeable
 * margin. Widening that gap by pushing beginner's topN further (5, 6, 8...)
 * only bought diminishing, increasingly noisy returns (the same saturation
 * this comment already documents). Pulling intermediate back toward expert
 * instead was far more effective per unit of change — comparing named
 * candidate configs on the same 250-board set (EW-only signed IMP vs a
 * pure/true-DD reference, matching PARTNER_FLOOR's asymmetry):
 *
 *   config                          signed IMP/hand   gap to the other tier
 *   beginner (topN=3, unchanged)         5.62                —
 *   intermediate (topN=2, prior)         5.04              0.58
 *   beginner pushed to topN=6            6.20              1.16 (from intermediate)
 *   intermediate pulled to topN=1        3.57              2.05 (from beginner)
 *
 * `intermediate: { topN: 1 }` — i.e. this dial OFF for intermediate, same as
 * expert — is the shipped choice: turning intermediate's card-selection
 * noise off entirely nearly quadruples the beginner/intermediate gap versus
 * the best achievable by pushing beginner further, using an already-
 * understood dial setting (not new extrapolation), and gives each tier a
 * legible identity: beginner is weak at both reading the table (K=1 blind)
 * and executing (BID_NOISE 3, PLAY_NOISE 3); intermediate reads the table
 * imperfectly (K=1, but auction-aware) yet never fumbles a known-best play;
 * expert is strong at both. `BID_NOISE.intermediate` is untouched (stays 2)
 * — only card-selection noise was judged to need hardening; see the tuning
 * guide for the full reasoning and how to revisit this call.
 *
 * A natural follow-up neither shipped constant can express: something
 * *between* topN=1 (never) and topN=2 (every noisy decision uses a top-2
 * draw) — e.g. a per-decision probability of applying topN=2 instead of a
 * hard on/off switch. Not built here; see the tuning guide's "open threads."
 */
export const PLAY_NOISE: Record<SettableDifficulty, { topN: number }> = {
  beginner: { topN: 3 },
  intermediate: { topN: 1 },
  expert: { topN: 1 },
};
