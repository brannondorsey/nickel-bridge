/**
 * Robot card-play difficulty tiers.
 *
 * 'expert' is the historical behavior: true-deal double-dummy play (the robot
 * effectively sees all four hands). Every tournament created before this
 * feature existed is 'expert' via the schema default, which is what keeps
 * their robot play — and the robot-trace fixture — byte-identical.
 *
 * Below expert, robots play sampled double-dummy (see play-mc.ts): each
 * decision samples K layouts of the cards the acting player can't see and
 * plays the card with the best total tricks across them. K is the difficulty
 * dial — small K misguesses queens like a club player, large K approaches
 * true double-dummy.
 *
 * kOpp applies to robot East/West (declaring or defending). kPartner applies
 * to robot North, who only ever acts as the human's defensive partner
 * (humanControls in server/src/game.ts gives the human every N-S hand when
 * N-S declares), and is floored so the human's partner never plays much worse
 * than the field even at low tiers.
 */
export type Difficulty = 'beginner' | 'intermediate' | 'expert';

export const DIFFICULTIES: readonly Difficulty[] = ['beginner', 'intermediate', 'expert'];

/**
 * Minimum sample count for the human's robot partner at any non-expert tier.
 * PLACEHOLDER — to be settled by the tools/calibrate_k.mjs sweep.
 */
export const PARTNER_FLOOR = 24;

/**
 * Sample counts per non-expert tier. PLACEHOLDER VALUES — run
 * `node tools/calibrate_k.mjs` and replace with calibrated numbers before
 * promoting non-expert play to real users. Changing these later changes robot
 * behavior for future boards of in-flight non-expert tournaments (an
 * invariant-1 comparability break for those tournaments only).
 */
export const MC_SAMPLES: Record<Exclude<Difficulty, 'expert'>, { kOpp: number; kPartner: number }> = {
  beginner: { kOpp: 8, kPartner: Math.max(8, PARTNER_FLOOR) },
  intermediate: { kOpp: 24, kPartner: Math.max(24, PARTNER_FLOOR) },
};
