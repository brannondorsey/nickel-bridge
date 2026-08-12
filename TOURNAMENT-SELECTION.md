# Tournament selection

How Nickel Bridge decides which tournament you get when you hit **Play**. The implementation
lives in `server/src/tournaments.ts` (`placeUser`, `chooseTournament`, `tournamentScore`, and
the `PLACEMENT` tuning block); the behavior is pinned by `server/test/placement.test.ts`.

## The problem

Tournaments are created just-in-time and never close. A naive shared queue — everyone plays
tournaments in the same strict order — breaks down when play volume is uneven: power players
drain the backlog and race ahead to a "frontier" where they're effectively playing alone,
because nobody else has caught up yet. That kills the duplicate comparison, which is the
whole point of the app.

## The algorithm

`POST /api/play` → `placeUser` picks a tournament in four tiers:

1. **Resume** — if you have a started-but-unfinished tournament, you go back to it. This
   tier has no time window: your own unfinished tournaments never expire on you.
2. **Grace window** — among tournaments you've never touched, any that is younger than
   `GRACE_TTL_S` (48h) **and** has fewer than `GRACE_CAP` (4) distinct starters is
   force-served. Newly created tournaments collect their first few players before entering
   normal scoring instead of dying as one-player orphans. Which one you get is
   **rescue, then fill, then freshness** (`graceOrder` in `tournaments.ts`): a tournament
   stranded at exactly one starter wins; failing that the fullest; failing that the newest.
   See [Grace ordering](#grace-ordering-rescue-then-fill) for why — this tier decides about
   half of all placements, so it is where nearly all the leverage in this algorithm sits.
3. **Scoring** — remaining candidates (created within the last `BACKLOG_WINDOW_S`, 30 days)
   are scored by popularity × recency:

   ```
   score = log(1 + distinct_finishers) · e^(−age / τ)
   ```

   where *distinct_finishers* is the number of distinct players with at least one completed
   board (each finished board is someone you can be matchpointed against), *age* is seconds
   since the tournament was created, and τ = `TAU_S` (30 days). If the best score is at
   least what a brand-new tournament would be worth — `log(1 + 1) · e⁰ = ln 2`, the
   **self-consistent threshold** — one candidate is served by **weighted-random sampling**
   among those within `SAMPLE_RATIO` (80%) of the top score (never below the threshold),
   proportional to score. Sampling instead of argmax keeps simultaneous arrivals from all
   piling onto a single tournament.
4. **Create** — if nothing beats the threshold, a fresh tournament is created… which the
   grace window then fills with the next few requesters.

### Why the threshold is `ln 2`

Creating a tournament puts you on brand-new deals with (so far) one future finisher: you.
So joining an existing candidate is only worth it if it scores at least that hypothetical
`(1 finisher, age 0)` tournament. A corollary: outside the grace window a candidate
effectively needs **two or more finishers** to be joined — a lone finisher's score
`ln 2 · e^(−age/τ)` sits below the threshold at any age > 0. That's deliberate: past its
grace window, a one-player tournament isn't worth joining over fresh boards.

### Grace ordering: rescue, then fill

This tier ran **oldest-first** until it was measured. `tools/calibrate_placement.mjs` replays
real placement demand through candidate policies (see [Measuring a change](#measuring-a-change)),
and it contradicted the reasoning that had produced the original rule.

**Oldest-first is not a neutral queue — it behaves like fullest-first.** Older candidates have
had the most time to accumulate starters, so FIFO keeps topping up boards that are already
fine while boards sitting at one human wait behind them and age out of the window alone. That
is invisible while play is evenly spread, and severe the moment one player out-produces
everyone else: production's heaviest player creates a tournament almost every time they play,
and those were the boards permanently at the back of the queue.

The fix is not simply to invert it. Measured over the real 279-demand trace, varying **only**
the grace ordering with every other knob at its production value —
`node tools/calibrate_placement.mjs --trace … --sweep frontier` reproduces this table:

| grace ordering | orphaned crossings | field at the average crossing | crossings with 4+ humans | first→last arrival (median) |
| --- | --- | --- | --- | --- |
| oldest-first (was) | 10 | 3.78 | 58.4% | 41.3 h |
| fullest-first | 15 | 3.96 | 62.7% | 33.6 h |
| emptiest-first | 8 | 3.82 | 50.5% | 22.6 h |
| rescue oldest-stranded first | 4 | 3.73 | 46.6% | 39.4 h |
| **rescue, then fill (is)** | **7** | **3.87** | **57.7%** | **22.6 h** |

Pure fullest-first buys the deepest fields and the *worst* loneliness — there is always
something fuller to prefer over a board at one player, and it is the only ordering here that
also creates tournaments beyond the floor (92 against 90). Pure emptiest-first inverts both,
spreading demand so thin that the share of crossings reaching four humans falls to 50.5%.

Neither wins because **the two goals only compete once every board has a second player**:
below that line rescuing is nearly free (turning a 4-way field into a 5-way is worth much less
than turning a 1-way into a 2-way), and above it, filling is unopposed. So the comparator does the cheap thing first and the good thing
second, and only breaks remaining ties on freshness.

That freshness tie-break is deliberately last. It never pulls a player off a rescue or a deeper
field; it only chooses among otherwise-equal boards, which is where most of the 41.3 h → 22.6 h
comes from. The gap it closes is the one that decides whether a shared board is worth talking
about: the people you are compared against played it the same day rather than two days later.

Row four is the refinement most people propose next, and it is the reason the tie-break is
freshness rather than urgency: rescuing the stranded board *closest to aging out* saves three
more crossings, but drags co-presence back to 39.4 h — nearly the old rule's — and gives up
the most field depth of any row here (46.6% of crossings reaching four humans, against 57.7%).
It trades a handful of lonely boards for making almost every shared board a two-day-stale
comparison. The knowing cost of choosing freshness instead is that a stranded board with hours
left on its grace window can still lose to one created minutes ago, and expire alone. Both are defensible; this
one is chosen because a field you can still talk about is the point of having a field.

Two numbers this table does **not** claim. Mean humans per tournament is unchanged and cannot
be improved — see [Measuring a change](#measuring-a-change). And "field at the average
crossing" moves only 3.78 → 3.87, because that quantity is nearly inelastic; the honest reading
is that this ordering fixes loneliness and co-presence *without spending field depth to do it*,
not that it deepens fields much.

### How long tournaments stay in rotation (τ = 30 days)

| Distinct finishers | Auto-served until roughly |
| --- | --- |
| 1 | grace window only (48h) |
| 2 | ~14 days |
| 3 | ~21 days |
| 4 | ~25 days |
| 5 | ~28 days |
| 6+ | the 30-day window edge |

With τ equal to the backlog window, the decay threshold and the window agree: even the most
popular tournament falls out of scoring right around the time it's archived.

## Archiving

Tournaments older than the backlog window are never *served*, but nothing is deleted:
they stay resumable (tier 1 is window-free), remain fully playable via their direct URL
(boards are dealt lazily on first open), and still count in the Elo replay if finished.

## Emergent properties

- **Power players become suppliers, not frontier-runners.** Whoever exhausts the recent
  backlog first creates the next tournament, and the grace window guarantees the next few
  requesters land on it — so the most active player seeds tomorrow's boards for everyone.
- **Returning after a few days off** doesn't force-march you through everything you missed
  in order. Your missed days form a scored backlog: what several friends finished ranks
  first; thin one-player leftovers have decayed below the threshold and are skipped.
- **Two friends returning after a long absence play the same deals.** If the whole group
  goes quiet past the window, the first returner triggers a fresh tournament and the second
  is grace-served into it — identical boards, instant head-to-head. This falls out of the
  grace mechanism; no special case needed.
- **Robot determinism is untouched.** Selection decides *which* tournament you get; deals
  derive from the tournament's stored seed, so everyone still faces identical robots on
  identical deals. The sampling RNG never affects gameplay.

## Tuning

All knobs live in the `PLACEMENT` const in `server/src/tournaments.ts`:

| Knob | Value | What it controls |
| --- | --- | --- |
| `TAU_S` | 30 days | how fast appeal fades — **the** knob to shrink as the group grows or plays more |
| `GRACE_TTL_S` | 48 hours | how long a new tournament can capture requesters |
| `GRACE_CAP` | 4 starters | guaranteed initial field (creator + 3) |
| `BACKLOG_WINDOW_S` | 30 days | how far back candidates reach; older = archived |
| `SAMPLE_RATIO` | 0.8 | how far below the top score the sampling pool extends |
| `NEW_TOURNAMENT_SCORE` | `ln 2` | derived from the scoring function — not an independent constant |

The current values are tuned for a small group (≈8 friends) playing short sessions once or
twice a day with multi-day gaps; at that volume the gentle 30-day decay makes placement
behave like "join the most comparison-rich tournament of the past month," which is what a
small field wants. `placeUser` accepts injectable `nowSec`/`rng`, and the scoring/selection
functions are pure and exported, so new values are easy to pin down in
`server/test/placement.test.ts` before shipping them.

## Measuring a change

Don't reason about these knobs from first principles — the grace-ordering result above is what
happens when you do. `tools/calibrate_placement.mjs` replays real placement demand through
candidate policies and reports what each one would have produced. Its `current` baseline calls
the real `chooseTournament` out of `server/dist`, so the comparison cannot drift from
production by transcription error.

```bash
npm run build
node .claude/skills/player-outreach/scripts/placement_trace.mjs "$SCRATCH/trace.json"
node tools/calibrate_placement.mjs --trace "$SCRATCH/trace.json" --sweep frontier
node tools/calibrate_placement.mjs --trace "$SCRATCH/trace.json" --set graceOrder=emptiest
```

The trace capture reads production and writes to a scratchpad, never the repo. `--synthetic`
needs no production access at all. Four things worth knowing before reading any output:

- **`meanField` cannot be improved, so don't report it as a win.** A player is never placed
  into a tournament they have already played, so the tournament count is floored at the busiest
  player's demand count — and production sits exactly on that floor. Mean field is pinned for
  any policy that doesn't create *more* tournaments than necessary. Read `soloPct` (crossings
  that ended with nobody to compare against), `fieldSeen` (`sum(f²)/sum(f)` — the field at the
  average *crossing* rather than the average tournament), and `span h` (co-presence).
- **`fieldSeen` is nearly inelastic** (3.6–4.1 across every ordering tried) since only its
  concentration can move. `soloPct` and `span h` are elastic, roughly 2× best to worst. Pick
  the policy that fixes those without spending depth.
- **Tune the grace tier first.** The `grace`/`score`/`new` counters in the output show it
  deciding about half of all placements against the scoring tier's tenth. `TAU_S`,
  `SAMPLE_RATIO` and the popularity score are near-inert at this scale — ablating each moved
  the outcome by 0.0–0.2pp, which is why shipping the grace ordering changed nothing else.
- **`BACKLOG_WINDOW_S` cannot be evaluated by the replay**, and the sweep silently looks like it
  can. Production's oldest tournament is younger than the 30-day window, so `--sweep window`
  returns identical rows for 30d and 60d because nothing in the trace reaches either. Use the
  arithmetic instead: a candidate crosses the `ln 2` threshold at `τ·ln(ln(1+finishers)/ln 2)`,
  i.e. 13.8 days at 2 finishers, 25.3 at 4, 31.0 at 6 — so the decay expires everything below
  six finishers before the window sees it, and the cutoff bites only the most popular
  tournaments.
