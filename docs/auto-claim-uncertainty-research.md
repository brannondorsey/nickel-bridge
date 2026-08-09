# Auto-claim and difficulty: research notes

## How auto-claim works today

`advanceRobots` (`server/src/game.ts:266-311`) runs a true double-dummy solve
(`solveFutureTricks`) at every non-forced play decision. `solveFutureTricks` sees all four
hands and assumes best play by everyone from that point on. If it finds the score is
`remainingTricks` (declaring side has a 100% laydown) or `0` (defense has a 100% laydown),
the board is marked `claimed`, `claimed_at_ply` is stamped, and `resolveClaim`
(`game.ts:362-366`) plays out **every remaining card for both sides via `chooseCard`** — the
plain DD-optimal picker (`pickFromSolve`), unconditionally, regardless of the board's
difficulty tier.

Ordinary (non-claimed) robot play instead goes through `robotCard` (`game.ts:331-353`),
which for any `difficulty !== 'perfect'` routes E/W (and, for beginner/intermediate, N as a
capped partner) through `chooseCardSampled` — belief formed from only `kOpp`/`kPartner`
sampled hidden-card layouts, `auctionAware` gating whether the auction is consulted at all,
and `PLAY_NOISE`'s `playTopN` softening the pick away from pure argmax.

## The bug

Both the **gate** (is this position settled?) and the **resolution** (how is the settled tail
played?) are true-DD, at every difficulty tier including `beginner` and `intermediate`. But
those tiers are defined precisely by NOT playing true-DD — that's the entire point of
`chooseCardSampled`'s `kOpp: 1`, `auctionAware: false` (beginner), and `PLAY_NOISE`. A
position that is a laydown against a perfect opponent is not necessarily a laydown against a
`beginner`/`intermediate` robot, which might misdefend or misguess a finesse in the "settled"
tail exactly as it would have anywhere else in the hand.

So the moment a claim fires:

1. **The gate itself is tier-blind.** It asks "is this 100% against perfect defense?", not
   "is this 100% against *this board's* robots?" A hand that's still genuinely in doubt
   against a beginner/intermediate opponent (declarer needs them to misdefend, or plans to
   guess a two-way finesse they'd get wrong at low K) gets claimed anyway, because DD sees
   through the very weaknesses that tier exists to model.
2. **The resolution silently upgrades the robots.** `resolveClaim` always calls the plain
   `chooseCard`/`pickFromSolve` path — never `robotCard`, never `MC_SAMPLES`/`PLAY_NOISE` —
   so for the rest of the hand every remaining robot decision (declarer's play if the human
   is defending, or the defense if the human is declaring) plays at hidden `'perfect'`
   strength. Any additional trick(s) the human's actual opponents would have donated by
   playing fallibly are deleted from the game.

Net effect: on beginner/intermediate boards, auto-claim can fire *too early* relative to what
those robots would actually do, and always *resolves too well* relative to them once fired.
Both directions bias the same way — toward taking value away from the human that the
weaker-robot tier promises them — and this is invisible to players since a claim just looks
like "the game correctly saw the end."

This is a preexisting, acknowledged gap — `.claude/CLAUDE.md`'s invariant 1 already flags it
as "an open question... worth measuring" and explains why a naive per-user opt-out wasn't
built (it would give two players on the same board different robots, contaminating
matchpoints/Elo). It has not been fixed or measured.

## Secondary effects

- **Tier calibration is silently wrong near the endgame.** `tools/calibrate_k.mjs` /
  `calibrate_stack.mjs` measure `MC_SAMPLES`/`PLAY_NOISE` effect sizes over full hands, but
  any hand that claims mid-play has its tail replaced by perfect play in *actual* production
  games — the calibration tools don't call `advanceRobots`, so they never see this
  substitution and are measuring a slightly different game than the one being shipped.
- **Analyze can't see it either.** `claimed_at_ply` correctly stops Analyze from grading past
  the claim boundary (so the human isn't blamed for server-played cards), but it also means a
  deficit the human "should" have accrued from a weak-tier robot's plausible defensive error
  never has the chance to happen — there's nothing to grade because DD already foreclosed it.

## A second, distinct issue: the human's own decisions

Separate from tier-blindness above, the gate is also blind to the HUMAN's own remaining
decisions. A laydown score (`bestScore === remainingTricks`) only says the outcome is fixed
with *correct* play by both sides — it says nothing about whether reaching it still requires
the human (declarer or dummy) to choose correctly among untied legal cards somewhere in the
tail. Today `resolveClaim` just force-plays `chooseCard`'s DD-optimal pick on the human's
behalf the instant `bestScore` matches, with no check that the human's own upcoming choices
were actually forced.

**Proposed criterion:** don't claim if the human (declarer or dummy) has a legal card, at any
point in the guaranteed line before the hand ends, that is not tied for that node's own best
score — i.e. a point where playing something other than the DD-optimal card would actually
cost tricks. Concretely, before committing to a claim, walk the DD-optimal continuation
forward node by node; at every point the human is to move with more than one legal card,
require ALL of them to tie for that node's best score (`solve.cardScores`). The moment one
doesn't, call the whole claim off and let the position play out normally — the human keeps
that decision instead of having it silently resolved for them.

This is scoped to the human's *declaring* side on purpose: a defending side's node, at either
bound of `solve.bestScore`, is mathematically always "tied" (0 is already the floor, nothing
legal can do worse), so the check only ever fires for a declarer/dummy decision. It's also
orthogonal to the tier-fallibility issue above — even at `'perfect'`, where every robot
decision genuinely is DD-optimal, the human's own remaining choices deserve to stay real
decisions rather than being auto-corrected.

Two implementation notes worth flagging for whoever picks this up:

- **Consistency with `analyze.ts`'s `deriveClaimBoundary`** (the fallback used when a board's
  `claimed_at_ply` wasn't persisted, e.g. for rehearsal branch-point validation). It currently
  re-derives the boundary from the same raw `bestScore` check inline — that duplicate would
  need to apply the identical human-decision check, or a rehearsal/Analyze could disagree with
  what `advanceRobots` actually did.
- **Performance.** Deferring a claim means `advanceRobots` would re-attempt this forward walk
  on every subsequent ply until the blocking decision is reached — naively that's an
  O(remaining plies²) solve count instead of O(remaining plies). A solve cache keyed on the
  exact plays-prefix, shared across attempts within one `advanceRobots` call, would be needed
  to keep it affordable; even so, a non-`'perfect'` tier's actual sampled play can diverge from
  the hypothetical DD-optimal line the walk assumes, so some of that added cost is inherent
  (more of a beginner/intermediate hand's tail goes through the same `chooseCardSampled` cost
  ordinary mid-hand play already pays, instead of being shortcut early by an over-eager claim).

This fix and the tier-fallibility fix below are independent and could ship separately or
together.

## Where a fix for the tier-fallibility issue would go

Both `advanceRobots`'s claim gate (`game.ts:277-296`) and `resolveClaim` (`game.ts:362-366`)
would need to become difficulty-aware to be consistent with `robotCard`. Two independent
levers, either or both:

1. **Gate on the tier, not on true-DD.** Only claim when a sampled solve at the board's own
   `MC_SAMPLES`/`PLAY_NOISE` settings is *also* 100% (or above some confidence threshold) —
   expensive (K solves instead of one true-DD solve) and probabilistic rather than exact, so
   "100%" would need redefining as a threshold.
2. **Resolve through `robotCard`'s tiered path instead of `chooseCard`.** Cheaper and more
   surgical: keep the true-DD gate (still correctly bars a claim on any position that isn't a
   guaranteed default outcome), but make `resolveClaim` play the tail the same way the rest of
   the hand would have been played — sampled/noisy for beginner/intermediate, per-seat
   (E/W vs. robot-partner-North) exactly as `robotCard` already resolves it. This preserves
   the "identical, guaranteed outcome" framing the current doc comment relies on for
   *declarer's own side* (still true-DD there, since declarer's own guaranteed tricks don't
   change) while letting the *opposing* robots keep making the tier's characteristic mistakes.

Either change is a "deliberate robot change" under invariant 1: it must be measured/
recalibrated and bumps `ANALYZE_VERSION`, and it changes `server/test/fixtures/robot-trace.json`
(fixture tournaments are `'perfect'`, so byte-identical there) only if perfect-tier resolution
also changes — option 2 above leaves `'perfect'` untouched since `robotCard` already
special-cases it back to `pickFromSolve`.
