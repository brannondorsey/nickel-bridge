# Difficulty calibration: real-world research + statistical simulation

**Status: research complete (2026-07), companion to PR #40** ("Give robot bidding a
difficulty dial; prototype card-memory decay"). That PR set `BID_NOISE` (bidding-noise
`topN`) and confirmed `MC_SAMPLES` (card-play `kOpp`/`auctionAware`) from single-seed
sweeps of 60–100 boards. This doc asks two questions PR #40 didn't: **is there a
real-world skill benchmark to calibrate against**, and **do the chosen constants hold up
at higher statistical power**? Short answers: no reliable external benchmark exists (this
is a genuine, confirmed gap in the whole hobby, not a research failure), and yes, the
constants hold up — with one clear recommendation to *not* ship the card-forgetting
prototype, and one caveat about what a "difficulty tier" actually differentiates in
aggregate. **§7 is a follow-up addendum** (independent research pass, same day) that
reconciles a second informal benchmark against §1's finding, refines §4's combined-stack
methodology, and identifies a genuinely new, previously-untested mechanism.

## 1. Is there a real-world skill-tier benchmark to calibrate against?

No — and this was checked hard, not assumed. A 102-agent research sweep (20 sources
fetched, 73 claims extracted, 25 adversarially verified 3-vote-per-claim) found:

- **The ACBL masterpoint rank ladder is real and well-documented** (Rookie → Junior
  Master → Club Master → Sectional Master → Regional Master → NABC Master → Life Master
  → colored Life Master tiers → Grand Life Master), confirmed against the official ACBL
  Codification and Handbook. But **ACBL's own documents explicitly call the skill
  correlation an assumption, not a measurement**: "the more masterpoints a player has,
  the more skilled he or she is *assumed* to be." Points are cumulative and
  never-decrease, weighted by event class/field size, not by how well you actually
  played. A forum thread has a longtime BBO admin stating flatly: "masterpoints are a
  lousy proxy for expertise, but it's still the only system we have" — and a poster with
  ~3,000 masterpoints (a high tier) reporting a 44% session game (well below average)
  while still collecting points for it. **No ACBL document anywhere publishes a
  matchpoint-%, IMP, or win-rate figure attached to any rank.**
- **No published error-rate-by-skill-level statistic survived verification.** Several
  precise-sounding numbers turned up in the initial search pass (a "3.1% double-dummy
  error rate," a "Defensive DDR" ratio distinguishing normal from cheating pairs, an
  ~81%-vs-80% double-dummy opening-lead-accuracy split between experts and club players)
  and **every one of them was refuted on direct source inspection** — one came from a
  patent-litigation exhibit, another from a page that on refetch contained no supporting
  data at all. These are flagged here specifically so they don't get treated as citable
  facts later: they are not.
- **No public documentation describes how any commercial bridge bot (BBO/GIB, Jack,
  WBridge5, Bridge Baron) actually implements difficulty tiers.** GIB's own published
  system notes cover only its bidding conventions and defensive method, nothing about
  tier mechanics. A BBO blog post that looked promising in a search snippet ("Basic" vs
  "Advanced" GIB) turned out, on full fetch, to describe a *bidding-system* selector
  (2/1 vs Precision vs 5-card majors) — not a skill-difficulty control at all.
- **The one general (non-bridge) game-AI paper that survived** (arXiv 2310.16581,
  minimax-MCTS difficulty adjustment) uses a *third* technique distinct from both of
  ours: it samples a target move-*value* from a per-tier Gaussian and picks the legal
  move closest to that value, at a fixed search budget across all tiers. It doesn't
  validate top-k/softmax noise on action probabilities (our bidding approach) or
  reduced Monte-Carlo sample count (our card-play approach) against each other, or
  against human data — it's a different axis, offered here only as one data point that
  "inject noise close to a value estimate rather than uniformly at random" is a
  recognized pattern for keeping weak play *plausible* rather than *obviously random*,
  which is the same principle our top-k-over-admissible-calls approach already follows.
- **Real clubs face the identical gap and cope the identical way.** Denver Bridge
  Club's "Intermediate/Novice" games are stratified by raw masterpoint brackets
  (0–20, 0–49, 0–99, 0–199, 0–299) — not by any measured performance metric. That's
  the same "self-reported/assumed experience bucket" shape as this app's own
  `beginner`/`intermediate`/`expert` preference field. We're not missing an industry
  standard; the industry doesn't have one.
- WBF/EBU rank-ladder equivalents were also not confirmed by any surviving source —
  open question, not resolved here.

**Implication:** there is no external number to tune `topN`/`kOpp` *to*. The right
methodology is what `tools/calibrate_k.mjs` already does — measure the dial's own
saturation curve and pick a point on it that's monotone, well-separated between tiers,
and structurally shaped like a human error (see §4) — just done here at higher N with
standard errors so the saturation claims are actually falsifiable.

## 2. Simulation methodology

All runs use the built `packages/core`/`packages/ai` dist output directly (no server/DB
involved), the `sl` model, seed `stat-*`/`stack-*`, and report mean ± standard error
(SE = sample stdev / √n) so point estimates from PR #40's smaller samples can be checked
for whether they were noise or signal. Scripts:
[`tools/calibrate_stats.mjs`](../tools/calibrate_stats.mjs) (per-mechanism sweeps, an SE-
and-extra-metrics companion to `calibrate_k.mjs`) and
[`tools/calibrate_stack.mjs`](../tools/calibrate_stack.mjs) (combined bid+play stack).
Score deltas are also converted to IMP-equivalents via the standard WBF/ACBL scale (a
well-established scoring convention, not a research claim) purely as a human-interpretable
yardstick for magnitude — 1 IMP ≈ a 20–40 point score difference, 4 IMP ≈ 130–160 points,
and so on.

## 3. Per-mechanism results (isolates one dial, holds the rest at reference)

### 3a. Card play — `kOpp` (200 boards, seed `stat-aware-1`/`stat-blind-1`)

Sampled defense/declarer vs. a true-DD reference; "flip%" = % of boards where the
made/down result itself changed.

**Auction-aware** (intermediate/expert config):

| K | def tricks conceded (mean±SE) | def >0% | decl conceded (mean±SE) | decl >0% | \|ΔNS\| mean±SE | flip% |
|---|---|---|---|---|---|---|
| 1  | 1.05±0.067 | 69.5% | 0.88±0.067 | 60.5% | 137.20±16.30 | 26.0% |
| 2  | 0.84±0.059 | 59.5% | 0.66±0.057 | 50.0% | 126.65±16.52 | 24.5% |
| 4  | 0.68±0.054 | 53.0% | 0.47±0.048 | 39.0% | 108.80±15.42 | 22.0% |
| 8  | 0.59±0.055 | 45.0% | 0.45±0.048 | 35.0% |  81.00±12.19 | 16.5% |
| 16 | 0.57±0.051 | 46.5% | 0.36±0.044 | 29.0% |  97.75±15.47 | 18.0% |

**Auction-blind** (beginner config):

| K | def conceded (mean±SE) | def >0% | decl conceded (mean±SE) | decl >0% | \|ΔNS\| mean±SE | flip% |
|---|---|---|---|---|---|---|
| 1  | 1.04±0.065 | 68.5% | 1.10±0.074 | 66.0% | 115.25±15.18 | 21.0% |
| 2  | 0.85±0.064 | 60.5% | 0.69±0.056 | 50.5% |  99.35±14.37 | 18.5% |
| 4  | 0.71±0.052 | 57.0% | 0.56±0.057 | 40.0% |  80.60±11.41 | 16.5% |
| 8  | 0.63±0.056 | 46.5% | 0.38±0.044 | 31.0% |  84.45±12.71 | 17.0% |
| 16 | 0.58±0.055 | 44.5% | 0.34±0.041 | 29.5% |  78.15±12.27 | 15.5% |

**Findings:**
- **PR #40's K=8-aware (expert) numbers replicate almost exactly** at 2× the sample
  size (def 0.59 vs the original 0.53, decl 0.45 vs 0.38, ΔNS 81 vs 82) — good
  cross-validation that the original single-seed calibration wasn't a fluke.
- **The declarer column is where auction-blindness actually bites**: at K=1, blind
  declarer play concedes 1.10±0.074 tricks vs. aware's 0.88±0.067 — a ~2.3-SE gap, real
  and mechanistically sensible (a declarer who ignores the auction can't place missing
  honors from opponents' bidding). Blind vs. aware *defense* is statistically
  indistinguishable (1.04 vs 1.05) — defenders' void-based inference matters more than
  their auction-based inference in this engine, so blindness costs the beginner
  tier specifically as declarer, not as defense. This is a more precise, falsifiable
  version of the "auction-BLIND... only novices don't count HCP from the auction"
  design note in `difficulty.ts` — confirmed, and now with a number attached.
- **Saturation confirmed, and the K=8→16 "improvement" is noise, not signal**: ΔNS
  actually *rises* slightly from K=8 (81) to K=16 (98) in the aware table — a ~1-SE
  wiggle, not a real reversal. Nothing past K=8 is worth its ~4× latency cost
  (`calibrate_k.mjs`'s own ms/decision column already showed this; this just confirms
  the score-delta plateau is real, not sampling luck).
- **Recommendation: keep `kOpp` = {beginner: 1, intermediate: 1, expert: 8}, `auctionAware`
  = {beginner: false, intermediate/expert: true}.** Well-separated at the boundary that
  matters (K=1 vs. K=8, ~3–4 combined-SE apart on every column) and the beginner/
  intermediate split via `auctionAware` alone (not a K change) is validated as
  targeting exactly the mechanism the design intends.

### 3b. Bidding noise — `BID_NOISE.topN` (300 boards, seed `stat-bid-1`, true-DD play both
sides to isolate bidding from card-play sampling)

| topN | auctions w/ deviation | deviations/auction | contract-changed% | level-changed% | \|ΔNS\| mean±SE | max |
|---|---|---|---|---|---|---|
| 1 | 0.0% | 0.00 | 0.0% | 0.0% | 0.00±0.00 | 0 |
| 2 | 42.3% | 0.61 | 31.0% | 21.3% | 85.17±11.01 | 1200 |
| 3 | 45.3% | 0.72 | 34.0% | 23.3% | 112.33±15.96 | 2800 |
| 4 | 45.7% | 0.73 | 34.7% | 23.3% | 106.57±15.42 | 2800 |
| 5 | 46.7% | 0.73 | 35.3% | 24.0% | 116.93±16.48 | 2800 |
| 6 | 47.0% | 0.73 | 35.3% | 24.0% | 118.23±16.56 | 2800 |
| 8 | 47.0% | 0.73 | 36.0% | 24.3% | 118.07±16.56 | 2800 |

**Findings:**
- **topN=1 is confirmed a mathematically exact no-op** (0.0 everywhere, 5× the sample
  size of PR #40's original check) — expert bidding is unchanged, as designed.
- **The dial saturates hard by topN=3–4**: topN 4/5/6/8 all cluster at 106–118±15–16 —
  completely overlapping error bars, i.e. statistically indistinguishable from each
  other. Going wider than topN=3 buys nothing.
- **topN=2→3 is a real but modest step** (85±11 → 112±16, ~1.4 combined-SE apart —
  suggestive, not airtight at this N, but consistent with the isolated deviation-rate
  columns also ticking up slightly, 42.3%→45.3% auctions-with-deviation). Given the
  dial saturates at ~118, topN=3 already captures ~95% of the achievable maximum effect
  and topN=2 captures ~72% of it — reasonable, deliberately-differentiated stopping
  points, not arbitrary.
- **Recommendation: keep `topN` = {beginner: 3, intermediate: 2, expert: 1}.** Matches
  PR #40's original choice; now confirmed at 5× the sample size with the saturation
  curve fully mapped rather than eyeballed from 5 grid points.

### 3c. Card-forgetting prototype (150 boards, seed `stat-forget-1`, K=1, paired per-board
comparison against a no-forgetting baseline at the same K)

| window | conceded (mean±SE) | >0% | \|ΔNS\| mean±SE | Δ vs. baseline (paired mean diff ± SE) |
|---|---|---|---|---|
| 0 (nothing remembered beyond current trick) | 1.07±0.084 | 66.7% | 159.67±24.89 | +0.000 ± 0.071 |
| 1  | 1.08±0.083 | 66.7% | 159.60±25.53 | +0.007 ± 0.070 |
| 2  | 1.07±0.083 | 66.7% | 153.07±24.46 | −0.007 ± 0.070 |
| 4  | 1.07±0.084 | 66.7% | 153.07±24.47 | −0.007 ± 0.072 |
| 8  | 1.05±0.083 | 66.7% | 149.80±24.36 | −0.020 ± 0.071 |
| 99 (= baseline, full memory) | 1.05±0.083 | 66.7% | 149.80±24.36 | 0 by definition |

Baseline (no forgetting) at K=1: 1.07±0.083 tricks conceded, 68.0% of boards >0.

**Finding: this confirms PR #40's tentative read, now with paired statistics instead of
a point-estimate range.** Every window's paired difference from the no-forgetting
baseline is within ~0.3 SE of zero — not just "small," but **statistically
indistinguishable from no effect at all**, in either direction. The likely reason: at
K=1, `sampleLayouts` is already drawing from a single, loosely-constrained hidden-hand
guess — forgetting a few tricks' worth of void evidence on top of that doesn't meaningfully
change how constrained the guess already wasn't.

**Recommendation: do not wire `play-mc-forget.ts` into a shipped tier as currently
designed.** If the idea is revisited, test it at higher K (e.g. K=8, where sampled
layouts are already meaningfully constrained by full void memory, so windowing that
memory has more room to matter) rather than at K=1 where there's little constraint left
to remove.

## 4. Combined effect: bidding + card play stacked on the same board (200 boards, seed
`stack-full-1`)

The sweeps above isolate one dial at a time (hold the other side at true-DD/pure-argmax).
Real tournaments stack both: noisy bidding can change the contract itself, and then
sampled card play changes tricks within whatever contract actually got reached. This runs
all four seats at one shipped tier's full config (bidding *and* play) and compares the
final board score to the same deal bid-and-played perfectly:

| tier | contract-changed% | \|ΔNS\| mean±SE | \|ΔNS\| median | mean IMP-equivalent | % boards ≥1 IMP |
|---|---|---|---|---|---|
| beginner | 37.5% | 212.25±19.79 | 60 | 4.33 | 73.0% |
| intermediate | 35.0% | 215.55±19.87 | 100 | 4.39 | 75.0% |
| expert | 0.0% | 111.65±15.51 | 20 | 2.34 | 52.0% |

**This is the most important — and most humbling — result in this doc.** Two things
stand out:

1. **Expert vs. the player-facing tiers separates cleanly** (0% contract-changed,
   because `topN=1` is an exact no-op, vs. 35–38% for beginner/intermediate; ΔNS
   roughly half). Expert boards are recognizably "almost the reference game" in a way
   the other two tiers are not.
2. **Beginner and intermediate are statistically indistinguishable in this aggregate
   metric** (212±20 vs. 216±20 — well under 1 combined SE apart), even though §3a/§3b
   showed both dials individually move monotonically in the intended direction between
   these exact two tiers. This is **not** evidence the tiers don't differ — it's evidence
   that **this particular aggregate number is the wrong instrument to see the
   difference with**: it's dominated by the heavy-tailed, high-variance boards where the
   contract itself changes (a changed contract can swing 60 points or 2800 depending on
   whether it clips a partscore or blows through a vulnerable game/slam), which drowns
   out the smaller, real, monotone in-contract card-play gap between the tiers at
   practical sample sizes. Getting this metric's SE down enough to resolve a true
   beginner/intermediate gap would need several thousand boards, not 200 — not worth
   the compute for a number that isn't the calibration surface anyway.

**Implication for tuning:** trust §3a/§3b (properly isolated, controlled comparisons) for
setting the constants — they already confirm monotonicity and saturation cleanly. Use
this section only for the "what does this feel like to a player" framing: **all three
player-facing tiers give up a meaningful, human-scale chunk of accuracy per board
(4+ IMP-equivalent, a ~35% chance of a different contract for beginner/intermediate)**,
and the sharpest, most legible difference a player will actually notice between "expert"
and "beginner/intermediate" isn't really "the score is worse" — it's "the contract
itself is sometimes visibly wrong," since that's the one behavioral signature (§3b)
that's exclusive to the noisy-bidding tiers and literally never happens at expert.

## 5. Summary recommendations

| mechanism | current value | verdict | confidence |
|---|---|---|---|
| `BID_NOISE.topN` (beginner/intermediate/expert) | 3 / 2 / 1 | **keep** — no-op confirmed at 5× N, saturation curve fully mapped, monotone and distinct | high |
| `MC_SAMPLES.kOpp` (beginner/intermediate/expert) | 1 / 1 / 8 | **keep** — expert cleanly separated; beginner/intermediate split via `auctionAware` targets declarer play specifically, as designed | high |
| `MC_SAMPLES.auctionAware` (beginner) | `false` | **keep** — the one mechanism confirmed to differentiate beginner from intermediate in isolation (declarer concession 1.10 vs 0.88 tricks) | high |
| `play-mc-forget.ts` card-memory decay | unshipped prototype | **do not ship as-is** — paired analysis confirms zero measurable effect at K=1; revisit only at higher K if at all | high (for "don't ship this version") |

And the one finding that isn't a "keep/change" verdict but matters for expectations:
**there is no external skill-tier benchmark this (or any) bridge app could calibrate
against — that's a confirmed gap in the hobby, not a gap in this research** — so the
saturation-curve-and-monotonicity methodology used here and in `calibrate_k.mjs` is close
to the best available approach, and matches (structurally) what real bridge clubs already
do when they stratify games by masterpoint bracket instead of measured performance.

## 6. Open questions (not resolved by this research)

- Whether WBF/EBU maintain a rank ladder with an actual performance/rating component
  (unlike ACBL's purely cumulative one) — not found by this sweep, worth a targeted
  follow-up if EBU/WBF-market calibration ever matters.
- Whether a large-enough combined-stack simulation (thousands of boards) would in fact
  resolve a real beginner/intermediate gap in the aggregate metric, or whether the two
  tiers are close enough in aggregate that the distinction is mostly felt through
  contract-stability rather than score magnitude — an open empirical question this
  doc's sample size can't settle.
- Third-party, non-authoritative performance-rating systems exist (e.g.
  bridgepowerratings.com, which derives a rating from game % adjusted for opponent/
  partner strength) and could in principle be mined for a real skill-to-performance
  curve if ACBL/WBF-official data never materializes — not pursued here since it's
  unofficial and wasn't part of the verified findings.

## 7. Addendum: reconciling an independent research pass, plus a new mechanism

A second, independent research pass (same day, different session — no shared context
with §1–§6) ran in parallel: web research plus its own statistical simulation, asking the
same underlying question this doc asks. Reconciling the two:

### 7a. Agreement, and one retraction

The two passes independently converged on every load-bearing conclusion in §1–§6:
`BID_NOISE`/`MC_SAMPLES` hold up as shipped, `auctionAware` genuinely differentiates
beginner from intermediate, and the card-forgetting prototype should not ship as
currently designed. That's strong cross-validation from two research efforts that
couldn't have anchored on each other.

The other pass's web research was more adversarially thorough than this doc's §1 and
turned up one thing worth recording plainly: an "expert-vs-club double-dummy
opening-lead-accuracy split (~81% vs ~80%)" statistic — which this doc's author had
separately found via a secondary citation (a site that returned HTTP 503 on direct
verification) and had flagged as unverified rather than citable — **was independently
checked and refuted on primary-source inspection** by the other pass. Treat that number,
and anything resembling it, as unreliable; it should not be cited in future work here.
Beyond that specific number, this doc's author had also been using an informal,
forum-sourced IMPs-per-board skill ladder (`bboskill.com`, via BBO Discussion Forums,
self-described by its own posters as "approximate based on experience") as a rough
external target for tuning purposes. §1's harder line — **no reliable published
skill-tier performance benchmark exists anywhere in the hobby** — is the better-supported
conclusion; the informal ladder should be read as color/context at most, never as a
calibration target. No committed code or doc in this repo depended on either retracted
number, so nothing needs correcting beyond this paragraph.

### 7b. A methodological refinement to the combined-stack test (§4)

§4's `calibrate_stack.mjs` measures the combined bid+play effect by weakening **all four
seats** to one tier's config and reporting **unsigned** `|ΔNS|`. That's a reasonable "how
far from a perfect board does this tier typically land" sanity check, but it isn't a
direct measurement of what the app's difficulty tiers do to a *human's* experience:
production never weakens North — `PARTNER_FLOOR` in `packages/ai/src/difficulty.ts`
always pins the human's partner at expert-opponent strength, regardless of tier. A metric
that also randomly degrades N (and S, standing in for the human) mixes in variance from a
seat the real game never touches, and taking `|diff|` can't distinguish "the tier helped
NS" from "the tier hurt NS" — both inflate the mean identically.

`calibrate_stack.mjs` now has an `--ew-only` flag: North/South stay pinned at pure
bidding/true-DD play throughout (mirroring `PARTNER_FLOOR` exactly), only East/West get
the tier's noise, and the report is **signed** IMP swing (positive = NS gained because the
opponents got weaker) instead of unsigned score distance. Rerunning §4's exact question
this way, at higher N (250 boards, seed `final-ew`):

| tier | contract-changed% | signed IMP mean±SE | IMP median | % boards \|imp\|≥1 |
|---|---|---|---|---|
| beginner | 25.6% | +3.37±0.34 | 1.00 | 70.4% |
| intermediate | 22.8% | +3.30±0.34 | 1.00 | 71.6% |
| expert | 0.0% | +1.70±0.20 | 0.00 | 37.6% |

This replicates §4's central finding — **beginner and intermediate are still
statistically indistinguishable in the combined metric** (+3.37±0.34 vs +3.30±0.34, well
under 1 combined SE apart) — even with the seat-isolation fix and a tail-compressing
signed-IMP yardstick that should, if §4's "heavy-tailed contract-changed boards are
swamping a real underlying gap" explanation were the whole story, have made the gap
easier to see. It didn't. That's evidence worth taking seriously: **within the currently
shipped mechanisms (`BID_NOISE` + `MC_SAMPLES`/`auctionAware`), beginner and
intermediate may not actually be separable by very much, methodological refinements
aside** — not because the individual dials don't move monotonically (§3a/§3b already
confirm they do), but because neither dial, even pushed hard, produces a large enough
combined effect to separate the tiers by a human-noticeable margin. Confirmed
independently across three separate implementations run this session (this tool, plus two
ad hoc scripts from the parallel session that reached the same ~3.1–4.4 IMP/board range
with the same <0.3 IMP gap).

### 7c. A previously-untested mechanism: card-selection noise

Every mechanism examined by both research passes — `K` sample count, `auctionAware`,
`BID_NOISE`, the forgetting prototype — only ever corrupts the acting player's **belief**
about the hidden cards. Given that belief (however corrupted), `chooseCardSampled` still
always deterministically plays the single highest-scoring legal card
(`pickFromSolve` is a pure argmax). Nothing examined so far touches the **decision** side:
does the AI always take the objectively-best card given what it (rightly or wrongly)
believes?

`packages/ai/src/play-mc-selectnoise.ts` (new, experimental, same
kept-out-of-the-barrel pattern as `play-mc-forget.ts`) tests this: instead of always
taking the argmax over the K-sampled layouts' scores, weighted-sample among the top
`playTopN` legal cards by that same score — the identical idea `BID_NOISE` already
applies to bidding, applied here to card play instead. Two independent measurements,
both via `tools/calibrate_stats.mjs playtopn` (the committed, production-code-path
version) and an ad hoc pooled sweep (~400 boards) from the parallel session:

**`calibrate_stats.mjs playtopn`, defense-side only, K=1 aware, 250 boards (seed `final-pn`):**

| topN | tricks conceded mean±SE | paired Δ vs. topN=1 baseline |
|---|---|---|
| 1 (= `chooseCardSampled`, no-op) | 0.98±0.052 | 0.012±0.051 |
| 2 | 1.29±0.064 | 0.328±0.058 |
| 3 | 1.35±0.069 | 0.384±0.061 |
| 4 | 1.42±0.070 | 0.460±0.066 |
| 6 | 1.52±0.069 | 0.556±0.062 |
| 8 | 1.53±0.070 | 0.568±0.063 |

**Ad hoc pooled sweep, any-EW-seat (declarer or defender), K1/auctionAware per tier,
signed IMP, ~400 boards:**

| topN | beginner IMP | intermediate IMP |
|---|---|---|
| 1 (baseline) | 3.45 | 3.48 |
| 2 | 4.49 | 4.31 |
| 3 | 5.20 | 5.32 |
| 4 | 5.45 | 5.52 |

**Both confirm the headline result — this is a large, real, well-powered effect (the
biggest lever either research pass has found), and topN=1 is a confirmed exact no-op —
but the two don't agree on the exact shape of the saturation curve**: the defense-only
trick-count measurement shows most of the gain already captured by topN=2 and mostly flat
after; the any-seat signed-IMP measurement keeps gaining meaningfully through topN=3–4.
The likely explanation is scope, not contradiction — the first isolates defensive card
play only, the second also captures declarer-seat weakening (which §3a already showed is
the larger of the two effects for auction-blindness, and plausibly is here too) — but this
wasn't independently confirmed by a scope-matched rerun, so treat the *exact* optimal
`topN` as uncertain by ±1–2, not the *existence* or *size* of the effect. **Notably, this
dial costs nothing extra at inference time**: raising `playTopN` re-weights the same
per-card totals the K-sample solve already computed, unlike raising `K` (which multiplies
solve count) — so unlike every other dial in this doc, the choice of `topN` here is a pure
design/feel decision, not a latency trade-off.

### 7d. Updated recommendation

Given 7b (the existing combined effect is small and hard to separate between beginner/
intermediate) and 7c (a large, currently-unused, zero-marginal-cost lever exists),
implementing `play-mc-selectnoise.ts` as a real `PLAY_NOISE` dial — analogous in
structure to `BID_NOISE` — looks like the most promising next step for making beginner/
intermediate meaningfully different from each other and from expert, more so than further
tuning of the existing dials (which §3a/§3b already show are saturated). A defensible
starting point, past the topN=1→2 knee in both measurements above without being deep into
the flattest part of either saturation curve: `PLAY_NOISE = { beginner: 3, intermediate: 2,
expert: 1 }` — same numeric shape as `BID_NOISE`.

**Update: implemented.** `PLAY_NOISE` at the values above now ships in
`packages/ai/src/difficulty.ts`, wired through `chooseCardSampled`'s new `playTopN` option
(`packages/ai/src/play-mc.ts`) and `server/src/game.ts`'s `robotCard()` — E-W only, never
robot North's partner seat. `play-mc-selectnoise.ts` (the standalone experimental prototype)
was deleted; its logic is now the shipped code path directly, following the same
`topN<=1` ⇒ byte-identical-to-prior-behavior pattern `BID_NOISE` established.
`tools/calibrate_stats.mjs playtopn` and `tools/calibrate_stack.mjs --ew-only` (see their own
doc comments) now exercise the real `chooseCardSampled`/`PLAY_NOISE` rather than the
deleted prototype module. `play-mc-forget.ts` remains unshipped, per 3c's recommendation.

**Second update: intermediate hardened.** Shipping `PLAY_NOISE` closed the "beginner and
intermediate are statistically indistinguishable" gap from 7b's own measurement (see the
constant's doc comment for the numbers), but not by as much as hoped — the two tiers still
landed within noise of each other on the combined signed-IMP metric (~5 IMP/hand each), a
near-guaranteed blowout when translated to this app's 4-board tournaments (~20 IMP/tournament)
for what's also the *default* tier every new user starts on. `tools/calibrate_whatif.mjs`
(new — compares named candidate configs, not just shipped tiers, against the same board set)
tested both directions: pushing beginner further (diminishing returns past its own documented
knee, best case ~1.2 IMP/hand gap) versus hardening intermediate back toward expert (turning
`PLAY_NOISE` off entirely bought ~2.0 IMP/hand, using an already-calibrated dial position, not
new extrapolation). Hardening intermediate won clearly on efficiency and shipped:
`PLAY_NOISE.intermediate: 2 → 1` (`BID_NOISE.intermediate` untouched, still 2). See
`PLAY_NOISE`'s doc comment for the full before/after table and
[`difficulty-tuning-guide.md`](difficulty-tuning-guide.md) for the general methodology this
investigation is now the worked example for.
