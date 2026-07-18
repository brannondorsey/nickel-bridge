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
 * At K=24-ish the calibration sweep measures ~0.4–0.5 tricks/board conceded
 * on defense — a solidly strong partner even on the beginner tier.
 */
export const PARTNER_FLOOR = 24;

/**
 * Sample counts per non-expert tier, calibrated with tools/calibrate_k.mjs
 * (40 boards, seed cal-1, tricks conceded per board vs an all-true-DD
 * reference):
 *
 *    K | defense | declarer | mean |ΔNS score| | ms/decision (trick 1)
 *    1 |   0.93  |   0.80   |      140        |    96
 *    8 |   0.63  |   0.35   |      106        |   340
 *   64 |   0.38  |   0.17   |       72        |  1840
 *
 * beginner kOpp=1 is the softest this architecture gets: opponents misjudge
 * ~1 trick per board on both defense and declarer play, so thin E-W contracts
 * actually fail and human declarers get the misguessed finesses a real table
 * gives. intermediate kOpp=8 plays like a solid club player. The dial
 * saturates near ~0.4 tricks by K≈32 while trick-1 latency grows linearly —
 * there is no reason to run K>16 in production. Changing these values changes
 * robot behavior for future boards of in-flight non-expert tournaments (an
 * invariant-1 comparability break scoped to those tournaments).
 */
export const MC_SAMPLES: Record<Exclude<Difficulty, 'expert'>, { kOpp: number; kPartner: number }> = {
  beginner: { kOpp: 1, kPartner: Math.max(1, PARTNER_FLOOR) },
  intermediate: { kOpp: 8, kPartner: Math.max(8, PARTNER_FLOOR) },
};
