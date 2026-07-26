# Data model behind the roster query

Read this before changing the SQL in `scripts/player_report.mjs`, or when you need to explain
what one of the numbers actually means. The short version: **"boards played" and "appears on the
leaderboard" are different tests, and the gap between them is where the interesting players are.**

## How the query reaches production

There is one machine and one volume (CLAUDE.md, "Deployment shape"), so there is no replica to
query and no read-only endpoint. The script asks the Fly Machines API to `exec` a small Node
program on the production machine; that program opens `/data/bridge.db` through the app's own
`better-sqlite3` with `{ readonly: true }`.

That flag is the load-bearing safety property. SQLite refuses writes on a read-only handle, so a
mistake in the SQL cannot damage production — it errors instead. Keep it if you touch the script.

Two operational details the script already handles, worth knowing if it ever breaks:

- **Machine IDs change on every deploy.** They're resolved at run time from the machines list;
  never hardcode one.
- **The app suspends when idle** (`autostop: suspend`), and a suspended machine can't `exec`. The
  script wakes it with an ordinary HTTPS request to `/health`, which is exactly what a player's
  first page load does, and lets Fly suspend it again on its own schedule.

## The tables that matter

| Table | What a row means |
| --- | --- |
| `users` | One account. `kind` is `'human'` or `'ai'` — the three `'ai'` rows are the benchmark house personas from `ai-players.ts` and must always be filtered out. |
| `boards` | One player's copy of one board. `state = 'done'` means they finished it. |
| `elo_history` | One *rated* tournament for one player. This is the leaderboard's gate. |
| `tournaments` | `kind = 'standard'` is real play; `'exhibit'` rows are demo-mode scenario holders and never count. |

## Why `boards_done` is not the leaderboard test

The leaderboard query in `server/src/app.ts` admits a player only when they have
`rated_tournaments >= PROVISIONAL_MIN_TOURNAMENTS` (which is `4`, defined in
`server/src/tournaments.ts`). A tournament rates a player only if:

1. they completed **all four** of its boards (`eloParticipants` filters on
   `p.length >= BOARDS_PER_TOURNAMENT`), **and**
2. at least two humans in that tournament did the same — an Elo round needs two rated pairs.

So 4 rated tournaments is *about* 16 finished boards, which is where the user's "16" comes from,
and it's a fair shorthand. But the two come apart in a way that matters for outreach: someone who
finished 16 boards spread across six half-played tournaments has **zero** rated tournaments and no
leaderboard row. They played plenty and still never reached the ranked list.

The script therefore reports both, plus `on_leaderboard` as the honest flag, and the `retained`
cohort accepts *any* of the three signals (16+ boards, 2+ days, or on the leaderboard) so that
nobody who clearly stuck around gets asked why they left.

## Where an abandoned board stopped

`boards_started` exceeding `boards_done` means an abandoned board. Those players are worth
separating from people who merely signed up, which is what the `abandoned_first` cohort does —
and the board row says exactly where they gave up, since `calls` and `plays` are JSON arrays
whose lengths are the auction and play progress.

Turning a call count into "did *they* ever bid" needs the seat maths, which comes from
`packages/core` rather than from bridge folklore:

- Seats are `0=N 1=E 2=S 3=W` and **the human always sits South (2)** (`types.ts`).
- `boardConditions` sets `dealer = (boardNo - 1) % 4`.
- `auctionState` puts seat `(dealer + i) % 4` on call `i`.

So South's first turn is at index `(2 - dealer + 4) % 4`, and every fourth call after that —
which is how `human_calls` is derived. On board 1 the dealer is North, so a board with exactly
two calls on it means the robots bid twice, the human's turn arrived, and they left without
bidding at all.

This is worth deriving carefully rather than eyeballing, because it ends up asserted to a real
person in an email, and "you left without making a single bid" is only a good line while it's
true. Note the bidding seat never flips: the North-hand flip in `game.ts` is a card-play concern.

## Column reference

| Column | Meaning |
| --- | --- |
| `boards_done` | Completed boards (`state = 'done'`) — the intuitive "how much have they played". |
| `boards_started` | All board rows, finished or not. Higher than `boards_done` means abandoned hands. |
| `rated_tournaments` | `elo_history` rows. `>= 4` puts them on the leaderboard. |
| `tournaments_touched` | Distinct standard tournaments they have any board in. |
| `days_seen` | Distinct UTC dates with board activity — the return-visit signal. |
| `first_seen` / `last_seen` | First and most recent board activity, as UTC dates. |
| `signed_up` | `users.created_at`. Compare with `first_seen` to spot signup-without-play. |
| `ab_board` | Board number of the unfinished board they walked away from (most recently touched), or `null`. |
| `stopped_at` | `auction` (never played a card) or `play` (cards were down) on that board. |
| `human_calls` | How many bids *they* made on it. `0` means they reached their first decision and made none. |
| `quiet_days` | Whole days between `last_seen` and today. `null` if they never played. |
| `too_recent` | A `friction` player still inside the cooldown — held, not dropped, because "you stopped playing" isn't yet a true thing to say to them. |
| `elo` | Current rating. `1200` exactly usually means "never rated", not "average player". |
| `excluded` | Operator/opt-out account. Counted in the roster, skipped when drafting. |

Dates are UTC, since `updated_at` is a Unix timestamp rendered with `date(..., 'unixepoch')`. For
`days_seen` this means a late-night session can straddle two "days" — fine for a coarse return
signal, worth remembering before anyone builds something precise on it.

## Changing the query

Keep every change inside the single `SELECT` in the `SQL` constant, keep the `readonly: true`
handle, and keep `u.kind = 'human'` — the house personas play constantly and would otherwise
dominate every cohort. After editing, run the script once and sanity-check the totals against the
previous run before drafting anything from it.
