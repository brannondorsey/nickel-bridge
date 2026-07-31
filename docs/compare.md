# Compare: two records, and the threshold between them

Compare (`/compare/:id`) puts the viewer's skill record beside another player's. This document
covers the one thing about it that isn't obvious from the code: **why most rows refuse to name a
winner**, and how the numbers that decide that were arrived at.

The reference is [`server/src/compare.ts`](../server/src/compare.ts) — constants and error models
live there with their own doc comments. This is the reasoning behind them.

## The problem it exists to solve

Put two rates side by side and a reader will treat the larger one as better. But "63% against 71%
declaring" is eight points across 58 boards and 74 — a gap you would expect from the shuffle
alone. A screen that colours that green flatters whoever happened to play fewer boards, and
flatters them *most* when it knows least.

So every judged row carries a **gate**: the margin below which the difference sits inside its own
measurement error. Three outcomes:

| State | Drawn as | Meaning |
| --- | --- | --- |
| **called** | coloured bar, side of centre | the margin cleared its gate |
| **level** | grey bar, still showing the lean | a real difference, short of the gate |
| **set aside** | hatched track, counted in a footnote | the gate is wider than the whole scale, so this row could never be called |

The third state is what makes the screen survivable on a young database. It says *the app cannot
tell you yet* rather than inventing an answer, and it self-heals as records grow.

## Direction is the encoding; colour only reinforces it

`--positive` is byte-identical to `--suit-c` and `--negative` to `--suit-h`. Worse, the colourblind
suit palette (`data-suit-palette="colorblind"`) rewrites the suit tokens and leaves these two
alone — so a player who turned that setting on *because* red and green are hard for them would
otherwise meet the one screen in the app that is entirely red and green.

The verdict is therefore carried by **which side of the centre line the bar grows toward** and
**whether it crosses its gate**. Flatten every fill to a single ink and the page still reports
every verdict correctly. Keep it that way — the greyscale check is the test.

(Whether `--positive`/`--negative` should gain colourblind overrides of their own is a separate,
worthwhile question: it would touch the score receipt and the monthly rating delta too. Compare
does not need it.)

## Three error models, and why they differ

The gate is `GATE_SIGMA × √(seA² + seB²)`. What `se` means depends on the measure, and getting
this wrong is easy because two neighbouring rows want different formulas.

**Rates** — declaring, defending, tops, and every bucket in the three lower panels — use the
binomial standard error **with the Agresti–Coull adjustment**: `p̃ = (x+2)/(n+4)` over `ñ = n+4`.

> This is required for correctness, not polish. The textbook `√(p(1−p)/n)` is **exactly zero** at
> p = 0 and p = 1, so a player who has made two contracts out of two would get a gate of zero and
> any difference against them would be called with total confidence. When this was written, **11
> of the 24 production players with any declared board sat at exactly 0% or 100%.** The displayed
> figure stays the raw rate; only the error is computed on the shrunk estimate.

**Bid accuracy** uses `σ/√n` over the actual score distribution, because it is the mean of a
**four-point discrete score** (`gradeFromProbs` returns 1 / 0.75 / 0.4 / 0), not a proportion. The
binomial formula overstates its spread by about a third. The trap is that the panel directly below
it — `bidTypes[]`'s satisfactory-or-better share — genuinely *is* a proportion, so the binomial
formula is correct there and wrong one row up.

Two pseudo-observations at the ends of the score range are added for the same reason as
Agresti–Coull: a player whose graded calls are all `excellent` has a sample variance of zero, which
is plausible at a nine-call record and would hand the row a gate of zero.

**Elo** gets a flat ±25 band and is never judged while either player is provisional. A rating is
not a rate over n trials, and the replay model (wiped and recomputed in tournament-id order on
every scored board) leaves no per-player variance to read off. 25 is roughly one K-factor swing.

Note the provisional quota arrives as an **argument**, never read from the constant — `DEMO=1`
relaxes it to `DEMO_PROVISIONAL_MIN_TOURNAMENTS`, and hardcoding it is exactly what once made the
activity feed's `entered-rankings` milestone unreachable in the environment built to click-test it.

## `GATE_SIGMA = 1.0`, and what it costs

Under the null hypothesis that two players are identical, a margin exceeds 1σ about **32%** of the
time. Across the ~19 measures this screen draws, that means roughly **six rows will be coloured by
chance alone on two genuinely equal players**. At 1.5σ it would be about 2.5.

It is 1.0 anyway, and the reason is the measured data below: at 1.5σ virtually every row was set
aside even for the five players with real records, and a screen that never says anything is not
more honest, only less useful. The mitigation is the entry floor — Compare is only offered to
players with a few hundred graded calls behind them, where the gates are tight enough that a
called row usually means something.

**If the page starts to feel like it flatters, `GATE_SIGMA` is the one number to move.** It is a
single named constant with a test pinning its value, so changing it is a deliberate edit.

## `COMPARE_MIN_BOARDS = 16`

Both players need 16 completed boards before Compare is offered — matching the outreach skill's
`RETAINED_BOARDS`, and roughly the four rated tournaments the leaderboard itself gates on.

Below that there is genuinely nothing to say: at the median record when this was written (4 boards,
9 graded calls, 2 declared boards) every measure is set aside. Both entry points hide themselves
below the floor, and a direct navigation gets an explicit "not enough crossings yet" screen naming
the shortfall — not an error, and not an empty page.

The server settles eligibility with two cheap `COUNT`s **before** building anything, so a thin pair
can never trigger two full profile builds.

## The measurement

Taken 2026-07-31 against production, read-only, quantiles only.

**47 human players with handles; 27 had completed a board; 5 had ≥ 16 boards.** Median record
across everyone who had played: 4 boards, 1 tournament, 9 graded calls, 2 declared boards. The
≥16-board cohort was the only one with meaningful records — median 78 boards, 218 calls, 20
tournaments.

`FULL_TILT` is calibrated on **that cohort's** p10–p90 spread. The whole-population spread is
sampling noise rather than skill: defending ran the full 0%–100%, because most players have two or
three defended boards.

| Constant | Value | Measured spread (n=5) |
| --- | --- | --- |
| `elo` | ±140 | 1077 → 1368 |
| `avgPct` | ±15 | 30.2 → 60.9 |
| `bidAccuracy` | ±7 | 70.9 → 84.5 |
| `declaring` | ±14 | 40.0 → 68.6 |
| `defending` | ±10 | 25.0 → 45.5 |
| `tops` | ±5 | 5.6 → 16.0 |
| `bidType` / `convention` / `contract` | ±15 / ±20 / ±20 | widened from the pooled ★★+ share |

The three bucketed panels are widened past the pooled figure on purpose: a per-bucket rate varies
more than the average of all buckets, so calibrating them to the pooled spread would set aside rows
that had something to say.

**n = 5 is a thin calibration sample.** Re-measure as the population grows — a read-only quantile
sweep over `boards`/`bid_evals` is all it takes, following the safety properties in
`.claude/skills/player-outreach/scripts/player_report.mjs` (remote payload opens the DB
`readonly: true`, fixed SELECT never built from argv). Note that `FULL_TILT` is load-bearing twice:
it scales every bar **and**, via the set-aside rule, decides which rows can be called at all. Too
tight a value retires rows that had something to say.

## Two things Compare deliberately does not do

**It does not fold anything away.** Bidding by type is the most actionable panel on the screen —
the largest samples in the app, and "your overcalls are nineteen points behind" is something a
player can act on — so hiding it behind a tap was wrong.

**It does not read `nb:lookback`.** The beam is all-time by design: a lookback window would move
every gate under the reader, since the gates are functions of sample size. If a windowed comparison
is ever wanted it needs its own control on this screen, not an inherited one.

## Caveats stated on the screen rather than engineered away

- **Matchpoints are field-relative.** `totalPct` is a score against *that tournament's* field, so
  comparing two career averages compares performance against different opposition — which is the
  problem Elo exists to solve. The row stays, with the caveat in the panel foot; head-to-head and
  common ground sit above the beam precisely because they *are* field-controlled.
- **Quadrature assumes independence.** Two players who share tournaments played the same deals, and
  their matchpoints within a shared field are anti-correlated, so the matchpoints gate is slightly
  wider than it needs to be for a well-met pair. Conservative in the safe direction.
- **Common ground is a record against each persona, not an average.** All three personas join every
  `ai_field` tournament, so "your matchpoints on boards where The Shark was in the field" is the
  same board set as The Novice's — three rows that would have printed the identical number. It is
  shown without a verdict: a weaker inference than the beam should not look as confident.
- **Volume and best crossing are never judged.** Playing more boards is not being better at them,
  and a maximum has no error term to test against. Trick delta has no winner at all — nearer zero
  is not better, since overtricks earn matchpoints.
