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
   force-served, oldest first. Newly created tournaments collect their first few players
   before entering normal scoring instead of dying as one-player orphans.
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
