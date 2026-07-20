# Tuning robot difficulty: a guide for contributors

This is the how-to companion to [`difficulty-calibration-research.md`](difficulty-calibration-research.md)
(the research log — what was measured, when, and why specific numbers were chosen) and the
doc comments in [`packages/ai/src/difficulty.ts`](../packages/ai/src/difficulty.ts) (the
reference — what each constant means, its own calibration table). Read this first if you're
about to change a difficulty constant, add a new one, or investigate whether two tiers feel
too similar; read the other two when you need the historical rationale or the exact numbers
behind today's values.

## The mental model: three dials, two different things they touch

Every robot decision (a bid, a card) at a player-facing tier is a **pure function of public
game state + a tournament seed** — never random, always reproducible, so every player on the
same (tournament, board) faces an identical robot (see invariant 1 in `CONTRIBUTING.md`; this
is the one rule every tuning change must preserve). Within that constraint, difficulty is
built from dials that fall into exactly two categories:

**Belief dials — corrupt what the robot *knows*.**

- `MC_SAMPLES[tier].kOpp` — how many hidden-hand layouts the robot samples before solving
  double-dummy. Fewer samples means a noisier guess at where the missing cards are.
- `MC_SAMPLES[tier].auctionAware` — whether the robot uses the auction's SAYC promises to
  narrow that guess at all, or draws blind (only shown-out voids still bind).

**Decision dials — corrupt what the robot *does* with an accurate belief.**

- `BID_NOISE[tier].topN` — instead of always bidding the model's single best SAYC-admissible
  call, draw from the top `topN` by probability.
- `PLAY_NOISE[tier].topN` — instead of always playing the single best-scoring card from the
  sampled layouts, draw from the top `topN` by score.

This split matters because **the two categories saturate completely differently.** Belief
dials hit a wall fast: even `kOpp=1` only concedes about a trick per board versus a perfect
hand, because the auction and void constraints already do most of the inferring — so pushing
`kOpp` up (more samples) or `topN` up on the decision dials past a small number all run into
diminishing, eventually noise-dominated returns. When you're tuning, expect every dial to have
a "knee" a few steps in, past which more effort buys almost nothing — see each constant's own
calibration table in `difficulty.ts` for where its knee actually sits.

**One more asymmetry that's a deliberate design choice, not a bug:** `PARTNER_FLOOR` in
`difficulty.ts` always pins robot North — the human's defensive partner, never an opponent —
at expert-opponent strength (`kPartner = max(kOpp, PARTNER_FLOOR)`, always `auctionAware`,
never subject to `PLAY_NOISE`), at every tier. Only East/West (the human's actual opponents)
vary with difficulty. Don't "fix" this without a deliberate product decision — it was
explicitly evaluated and kept during this round of tuning (see the calibration doc's
reconciliation section).

## How to measure the effect of a change

Four metrics, roughly in order of how directly they answer "does this feel different":

1. **Tricks conceded** (sampled vs. a true-DD reference, same auction/contract). The most
   granular, lowest-variance metric — good for isolating one belief dial at a time.
   `calibrate_k.mjs`'s and `calibrate_stats.mjs kgrid`'s native unit.
2. **|ΔNS score| in raw points.** One level up — folds tricks-conceded through the actual
   scoring table (a trick in a slam is worth far more than a trick in a partscore). Useful for
   isolated-mechanism sweeps (`calibrate_k.mjs --bid-topn`, `calibrate_stats.mjs bidtopn`).
3. **Signed IMP swing, EW-only, vs. a pure/true-DD reference.** The most policy-relevant
   number: North/South (the human's side, partner always at `PARTNER_FLOOR`) stay at full
   double-dummy strength throughout; only East/West vary. Positive means the human's side
   gained IMPs because the opponents got weaker — this is "how much easier did this tier just
   make the game," in the same currency real bridge players use to size up a result.
   `calibrate_stack.mjs --ew-only` and `calibrate_whatif.mjs` report this.
   **Translate it to something felt, not just a number**: this app's tournaments are 4 boards
   (`BOARDS_PER_TOURNAMENT` in `server/src/db.ts`), so a mean edge of `X` IMP/hand compounds to
   roughly `4X` IMP over a full tournament on average. 5 IMP/hand → ~20 IMP over 4 boards,
   which is a blowout (more than two full game swings); ~1.5–2 IMP/hand → ~6–8 IMP over 4
   boards, closer to "one swung partscore," a genuine contest. When picking a target, ask what
   a whole tournament would feel like, not just one hand.
4. **Contract-changed %.** Only `BID_NOISE` moves this (card play never changes what contract
   gets played). Per the calibration doc's own finding, this may be **the single most legible
   signal to an actual player** — a human notices "the auction went somewhere weird" far more
   readily than "the defense's card play was 0.3 tricks worse than optimal." Don't ignore it
   just because it's not the primary tuning target.

**Sample size matters more than it looks like it should.** Board-to-board score variance is
large (bridge literature puts single-board IMP standard deviation around 5 — see the
calibration doc's §1). At 60–100 boards, point estimates can look monotone by luck alone; at
200–300 boards with reported standard error, you can tell signal from noise. When a table in
this codebase reports `±SE`, treat differences smaller than roughly one combined SE as "not
established" — don't over-read them.

## The tools

| Tool | What it measures | Use it for |
|---|---|---|
| `tools/calibrate_k.mjs` | K grid, `--bid-topn`, `--forget-window` — the original single-seed-friendly sweeps | Quick first look at a new dial or a K change |
| `tools/calibrate_stats.mjs kgrid\|bidtopn\|forget\|playtopn` | Same sweeps, with standard error + contract/flip-rate columns | Confirming a `calibrate_k.mjs` finding wasn't noise; picking a `topN`/`K` value with confidence |
| `tools/calibrate_stack.mjs [--ew-only]` | Combined bid+play effect for the actual shipped tiers | "How does a whole tournament feel at this tier, right now" |
| `tools/calibrate_whatif.mjs` | Combined effect for **named candidate configs**, not just shipped tiers | "Should we change tier X or tier Y to fix problem Z" — the tool used for the beginner/intermediate investigation below |

All are plain Node scripts against the built `packages/core`/`packages/ai` output — `npm run
build` first, then `node tools/<script>.mjs [flags]`. All are deterministic given a `--seed`;
rerun with a different seed before trusting a borderline result.

`calibrate_whatif.mjs` is the newest and the one you'll likely reach for most: it mutates
`MC_SAMPLES`/`BID_NOISE`/`PLAY_NOISE.intermediate` in-process as a scratch "vehicle" slot per
candidate row (never `beginner`/`expert`, so a candidate config can never corrupt a real tier
mid-run), replaying the *same* prepared board set across every row for a fair, low-variance,
paired comparison. Edit the `CONFIGS` array at the bottom of the file to add candidates —
each row is `[label, kOpp, auctionAware, bidTopN, playTopN]`, or `[header, null]` to print a
grouping label without measuring anything.

## The safety checklist for changing any constant in `difficulty.ts`

1. **Measure first** (see above) — don't hand-tune by feel alone; every shipped value in this
   file has a calibration table backing it.
2. **Regenerate and diff the trace fixture**: `npm run build && node tools/gen_trace_fixture.mjs`,
   then check `git status`/`git diff` on `server/test/fixtures/robot-trace.json`. It **must**
   come back clean for any change scoped to `MC_SAMPLES`/`BID_NOISE`/`PLAY_NOISE` — the
   `'perfect'` tier (which the fixture, exhibit tournaments, and every legacy pre-difficulty
   tournament resolve to) bypasses all three by construction. A diff means you accidentally
   touched the `'perfect'`/no-`opts` code path — stop and find out how before proceeding.
3. **Run the full suite**: `npm test` (and `npm run typecheck`). The server suite's
   `difficulty.test.ts` "sampled robots are deterministic across players" test is the
   duplicate-fairness regression guard for whatever you changed — it should still pass
   unmodified.
4. **Know what you're breaking**: changing any of these constants changes robot behavior for
   future boards of **in-flight, already-started non-`'perfect'` tournaments** — an accepted,
   documented comparability break (invariant 1 in `CONTRIBUTING.md`), not a bug. State it in
   the commit message; don't be surprised by it later.
5. **Update the doc comment you just invalidated.** Every constant's calibration table lives
   right above it in `difficulty.ts` — if your change makes that table stale, replace it with
   the new one (see the `PLAY_NOISE.intermediate` comment for the current example of
   documenting a *revision*, not just an initial value, including the reasoning for why the
   old value changed).

## Worked example: the beginner/intermediate investigation

This is the shape future tuning questions will probably take, so it's worth having a template.

**Symptom:** after shipping `PLAY_NOISE`, `calibrate_stack.mjs --ew-only` showed beginner and
intermediate landing within noise of each other in the combined signed-IMP metric (~5 IMP/hand
each), even though each individual dial (K/`auctionAware`, `BID_NOISE`, `PLAY_NOISE`) had been
confirmed to move monotonically between the two tiers in isolation. Translating that 5 IMP/hand
into "over this app's 4-board tournaments" (~20 IMP) made it concrete: that's a near-guaranteed
blowout, and intermediate is the *default* tier every new user starts on — too easy a default,
and too close to beginner to feel like a distinct step.

**Two hypotheses, one tool:** widen the gap by pushing beginner further (more noise), or by
pulling intermediate back toward expert (less noise). `calibrate_whatif.mjs`, run with several
named candidates for each direction against the same 250-board set, answered it directly:
pushing beginner's `PLAY_NOISE` to `topN=6` (past its own documented knee) bought a gap of
about 1.2 IMP/hand — diminishing, uncertain territory. Turning intermediate's `PLAY_NOISE` off
entirely (`topN=1`, the mildest hardening option tested) bought a gap of about 2.0 IMP/hand —
using an already-understood dial position, not new extrapolation.

**Decision:** harden intermediate (`PLAY_NOISE.intermediate: 2 → 1`), leave beginner and
`BID_NOISE.intermediate` untouched. Cheaper, bigger effect, and it gives each tier a legible
identity (see the constant's own doc comment for the full writeup). The pattern to reuse: when
two tiers feel too similar, don't just push the "easy" one further — check whether hardening
the "hard" one gets you there more efficiently, and let `calibrate_whatif.mjs` answer with
data instead of intuition.

## Open threads (known limitations, not urgent)

- **No fractional `topN`** — yet. `BID_NOISE`/`PLAY_NOISE` are integer counts today, so
  there's no way to land "between" `topN=1` (off) and `topN=2` (every noisy decision draws
  from the top 2). Here's how to actually build it, not just the idea:

  **The mechanism**: a seeded coin flip that rounds a fractional `topN` up or down, weighted
  by its fractional part — `topN=1.5` resolves to 2 half the time and 1 the other half
  (in the rng stream, so still duplicate-fair); `topN=2.25` resolves to 3 a quarter of the
  time and 2 the rest. This generalizes to *any* positive value, not just "1 point 5" — it's
  a genuinely continuous dial across the whole range, not a special case.

  ```ts
  // packages/ai/src/difficulty.ts — colocated with BID_NOISE/PLAY_NOISE since both
  // consumers already import from here.
  /**
   * Resolves a possibly-fractional topN to a whole candidate count via a seeded
   * coin flip on the fractional part. topN=1 or topN=2 exactly (frac=0) never
   * draws — the existing "topN<=1 is a byte-identical no-op, zero rng draws"
   * invariant holds unchanged for every config that stays integer-valued.
   */
  export function resolveTopN(topN: number, rng: () => number): number {
    const floor = Math.floor(topN);
    const frac = topN - floor;
    return frac === 0 ? floor : rng() < frac ? floor + 1 : floor;
  }
  ```

  **Where it plugs in** — both call sites already do (or, for play-mc.ts, already can) hold a
  single seeded rng instance across a whole decision, which matters here: `resolveTopN`'s coin
  flip and the final weighted pick must draw from the *same* stream, not two independently-
  constructed `seededRng(seed)()` calls (those would silently replay the same first random
  number for both draws — a correctness bug, not just a style nit).

  - `packages/ai/src/play-mc.ts`'s `chooseCardSampled` already builds one `const rng =
    seededRng(opts.seed)` up top and reuses it for `sampleLayouts` and the final pick — just
    insert `const resolvedTopN = resolveTopN(opts.playTopN ?? 1, rng);` before the existing
    `if (playTopN <= 1)` check and use `resolvedTopN` from there on.
  - `packages/ai/src/bidder.ts`'s `noisyBest` currently instantiates `seededRng(seed)()`
    inline, once, right at its one draw — that needs to become `const rng = seededRng(seed);`
    at the top of the function instead, so `resolveTopN(topN, rng)` and the later `rng()` call
    for the weighted pick share a stream.

  **No type or config-shape change needed** — `BID_NOISE`/`PLAY_NOISE` are already typed
  `{ topN: number }`, so `{ topN: 1.5 }` is already legal TypeScript; only the two call sites
  above need the `resolveTopN` insertion to make it *behave* as a blend instead of (as it does
  today, silently) truncating and wasting an unnecessary rng draw. No calibration-tool changes
  either — every sweep already parses `--topn`/`CONFIGS` values with `Number(...)`, which
  accepts decimals natively; e.g. `node tools/calibrate_stats.mjs playtopn --topn
  1,1.25,1.5,1.75,2` would work immediately once `resolveTopN` is wired in.
- **`play-mc-forget.ts` (card-"forgetting") remains unshipped.** Confirmed near-zero effect at
  `K=1` (see the calibration doc §3c) — the belief a `K=1` sample already holds is loose enough
  that windowing its memory further doesn't change much. Worth a second look only at higher
  `K` (e.g. expert's `K=8`), where there's a tighter belief left to degrade.
- **No external real-world skill-tier benchmark exists** (checked hard, not assumed — see the
  calibration doc §1). Tune by internal saturation/monotonicity/separation against your own
  targets (a specific IMP/hand number, a specific tournament-level feel), not by trying to
  match an outside number — there isn't one to match.
- **Isolated-mechanism and combined-mechanism measurements don't always agree on exact
  saturation shape** (see `PLAY_NOISE`'s doc comment) — likely because combined tests also
  capture declarer-seat effects an isolated defense-only sweep doesn't. Treat a single
  measurement's precise optimal `topN`/`K` as approximate; treat its *direction and rough
  magnitude* as reliable, especially once replicated across seeds or measurement designs.
