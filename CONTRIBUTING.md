# Contributing to Nickel Bridge

This guide is the technical map of the codebase for contributors — human or AI. The
[README](README.md) covers what the app is, its features, and how to deploy it; this file
covers how the code is organized, how to work on it, and which invariants you must not break.

> **Note for AI agents:** this file is symlinked as `.claude/CLAUDE.md`, so Claude Code loads
> it automatically as project memory. Trust it as a starting point, verify against the code
> when something is load-bearing, and [keep it up to date](#keeping-this-guide-up-to-date).

## Tech stack

- **TypeScript** everywhere (`strict: true`, `module`/`moduleResolution: NodeNext` —
  see `tsconfig.base.json`). **Node >= 24** required.
- **npm workspaces** monorepo: `packages/*`, `server`, `web`.
- **Server:** Fastify 5, `better-sqlite3` (synchronous SQLite), cookie sessions, Google OAuth.
- **Web:** React 19 + `react-router-dom` 7, built with Vite 8. No chart library — sparklines
  are hand-rolled SVG. Fonts self-hosted via `@fontsource` (imported in `web/src/main.tsx`).
- **AI:** pure-TypeScript MLP inference (no GPU/native ML deps) + vendored DDS WebAssembly
  double-dummy solver.
- **Tests:** Vitest (unit/integration, including a jsdom + Testing Library suite in `web`),
  Playwright (browser smoke).
- **Python** appears only in `tools/` for offline, one-time fixture/weight generation.

## Repo map

```
packages/core   game rules — no I/O, no deps. deck.ts (deterministic dealing/PBN/HCP),
                auction.ts + play.ts (state machines), score.ts (scoring + matchpoints),
                elo.ts (pairwise Elo, start 1200 K=24), sayc.ts (the SAYC bid explainer,
                biggest file in core), advisor.ts (checks a hand against a meaning's
                machine-readable `req` constraints — saycConsistent feeds bid grading,
                saycViolation feeds the robot bidding guardrail), types.ts,
                barrel in index.ts
packages/ai     model.ts (loads models/{sl,rl-fsp}.{json,bin}, 4×1024 MLP → 38 logits),
                encode.ts (bit-for-bit port of pgx bridge_bidding observation encoding),
                bidder.ts (chooseCall = model argmax constrained to SAYC-admissible
                bids — any bid violating its own exact SAYC meaning's `req` is
                excluded, pass always allowed; at non-'perfect' difficulty, seeded
                noisy sampling over the top BID_NOISE[tier].topN admissible calls by
                probability softens the tier-blind argmax, see difficulty.ts;
                grading by model probability ratio,
                floored at 'good' when core's advisor confirms the call is a SAYC
                convention the hand satisfies; docs/rule-based-bidding.md maps the
                design space), play-ai.ts (DD-optimal card
                play via vendor/bridge-dds WASM), play-mc.ts (sampled-DD card play
                for non-expert difficulty tiers: K seeded hidden-hand layouts
                constrained by the auction's SAYC `req`s + shown-out voids, solved
                per layout, aggregate scores summed per legal card — then, per
                PLAY_NOISE, either the flat argmax or a seeded weighted pick among
                the top playTopN cards by that same score), difficulty.ts (tier
                type + K/BID_NOISE/PLAY_NOISE constants), dd-pool.ts/dd-worker.ts
                (lazy worker_threads DDS pool for parallel sampled solves —
                latency only, never outcomes), play-mc-forget.ts (EXPERIMENTAL,
                unshipped card-"forgetting" prototype — see its doc comment and
                docs/difficulty-calibration-research.md)
server          index.ts (entry) → app.ts (buildApp(): all routes, serves web/dist),
                auth.ts (Google OAuth + DEV_AUTH dev login), db.ts (schema DDL, WAL),
                game.ts (loadBoard/submitCall/submitPlay/advanceRobots/boardView),
                tournaments.ts (JIT placement, standings, recomputeElo), stats.ts,
                ai-players.ts (benchmark AI personas — the "house" rows ranked in
                The Field, see "Benchmark AI players" below), bot-play.ts (the shared
                strategy-injected bot board-play loop used by the demo seeder AND the
                AI personas), demo.ts + scenarios.ts + demo-seed.ts (DEMO=1 demo mode,
                on PR previews + the permanent demo app — see "Demo mode" below)
web             main.tsx → App.tsx (router + MeContext auth + splash gating + TabBar),
                api.ts (typed API client), splash.ts (nb:lastVisit returning-visitor gate),
                theme.ts (nb:theme night-mode preference — see "Night mode" below),
                pages/ (Board.tsx is the gameplay UI; sign-out AND the night-mode switch
                live on the Stats page; Scenarios.tsx is the demo-mode gallery;
                Glossary.tsx is the glossary screen; Tour.tsx is the first-crossing
                onboarding tour),
                onboarding/ (the "first crossing" new-user tour data: board0.json, an
                engine-captured practice deal regenerated by tools/gen_tour_board.mjs;
                board0.ts its lazy loader; script.ts the hand-curated tollkeeper
                narration; tour.test.tsx the script↔capture drift guard — pages/Tour.tsx
                replays the capture through Board.tsx's exported BiddingPhase/PlayPhase,
                see "The first crossing" below),
                glossary/ (the Interactive Glossary: terms.ts curated core data + themes,
                deep.json the generated Wikipedia-derived deep reference (CC BY-SA 4.0,
                lazy-loaded via deep.ts — one of the web bundle's two dynamic imports,
                the other being onboarding/board0.ts), linkify.ts
                the prose matcher, search.ts the Glossary-page filter/group helpers,
                GlossaryContext.tsx the app-wide term-sheet provider, TermSheet.tsx the
                sheet itself, Attribution.tsx the shared CC BY-SA credit block — see
                "The glossary" below),
                index.html (the SPA shell — holds the site-wide SEO block between its
                seo:start/seo:end markers, which the glossary prerender replaces per
                page, plus the pre-paint night-mode script),
                public/ (favicon.svg + og-image.png, the checked-in social share card),
                components/ds/ (design-system pieces, incl. SignInBar — the logged-out
                glossary's bottom bar, standing in for the TabBar) + components/game/ (auction, bid box,
                fans, trick area, deal diagram, toll-receipt score breakdown,
                GlossaryProse.tsx — SuitText + tappable glossary terms),
                src/test/ (fixtures + apiMock pattern),
                style.css (all styling — token blocks ported from the design prototype;
                [data-theme="night"] + its @media (prefers-color-scheme: dark) twin hold
                the night token overrides)
tools           offline Python weight conversion + golden-fixture generation;
                gen_trace_fixture.mjs regenerates the robot determinism trace;
                policy_probe.mjs prints the model's policy for any hand + auction
                (build first: `node tools/policy_probe.mjs "K98.QT95.AQJT5.7" --calls "1H P"`);
                find_scenarios.mjs records/mines demo-scenario replay recipes (offline —
                results are hand-curated into server/src/scenarios.ts);
                gen_glossary_deep.mjs regenerates web/src/glossary/deep.json from
                Wikipedia's bridge glossary (offline; pass a saved HTML file in
                network-restricted environments — see its doc comment);
                gen_tour_board.mjs mines + captures the onboarding practice board
                (web/src/onboarding/board0.json) by driving the real engine offline —
                see "The first crossing" below;
                gen_glossary_static.mjs is the odd one out — a BUILD STEP, not an
                offline generator: web's `build` script runs it after `vite build` to
                prerender the glossary into web/dist/glossary-static/ + sitemap.xml,
                see "Discoverability" below;
                calibrate_k.mjs sweeps sampled-DD K values (plus --bid-topn/--forget-window)
                against true-DD reference play; calibrate_stats.mjs is the same sweeps with
                standard error; calibrate_stack.mjs measures the combined bid+play effect for
                the shipped tiers (--ew-only: signed IMP, matches PARTNER_FLOOR's asymmetry);
                calibrate_whatif.mjs compares named CANDIDATE configs (not just shipped tiers)
                for "should we change tier X or Y" questions — see
                docs/difficulty-tuning-guide.md for how these fit together
scripts         e2e.mjs (full two-user tournament against a running instance), ui-check.mjs
                (design-review sweep of every screen → docs/images-redesign/),
                readme-shots.mjs (the README's marketing shots → docs/screenshots/ —
                plays an ordinary tournament on a DEMO=1 instance, see that dir's README),
                og-image.mjs (regenerates the checked-in social share card
                web/public/og-image.png — offline, no running instance needed)
e2e             smoke.spec.ts — Playwright smoke at phone viewport (390×844)
docs            design-brief.md — requirements spec for the visual redesign;
                rule-based-bidding.md — why robot bids are SAYC-guardrailed and the
                shelved full rule-engine design; difficulty-tuning-guide.md — how to reason
                about/measure/tune the difficulty dials in packages/ai/src/difficulty.ts;
                difficulty-calibration-research.md — the research log behind today's values;
                onboarding-design.md — the new-user onboarding ("first crossing") design
                spec, with its clickable prototype
                onboarding-prototype.html and concept-exploration board
                onboarding-concepts.html;
                screenshots/ + images-redesign/ + images/ — the README shots, the design-review
                sweep, and the pre-redesign "before" (each dir has a README)
.claude         CLAUDE.md symlink (→ this file) + settings.json (the permission +
                auto-mode allowances that let the outreach routine run unattended —
                see "Unattended outreach permissions" below); skills/nickel-bridge-design/,
                the design-system skill — see "Design system" below; and
                skills/player-outreach/, the operator skill that reads the production
                roster and drafts the weekly player emails — see "Player outreach" below
```

## Development workflow

```bash
npm install
npm run build            # builds core → ai → server → web, in that order (order matters)
DEV_AUTH=1 npm run dev   # server on :3000 with name-only login (no Google creds needed)
npm run dev -w web       # Vite dev server on :5173, proxies /api, /auth, /demo to :3000
```

Checks — run all three before pushing; CI runs exactly these plus the Playwright smoke and a
Docker build (`.github/workflows/ci.yml`, on pushes to `main` and all PRs). Once those pass,
CI also deploys: every open PR gets its own Fly.io preview app (destroyed on close by
`.github/workflows/pr-preview-teardown.yml`), and every push to `main` deploys to production
*and* redeploys the permanent demo app (`nickel-bridge-demo`, demo.bridge.brannon.online — a
stable DEMO=1 instance for automation and click-testing) — see README.md "Deployment" for the
one-time Fly setup and how preview auth (`DEV_AUTH`) works. Separately,
`.github/workflows/claude-pr-review.yml` runs Claude (via `anthropics/claude-code-action`) on
every newly opened PR and posts a non-blocking review comment — authenticated via the
`CLAUDE_CODE_OAUTH_TOKEN` repo secret (a `claude setup-token` OAuth token billed against a
Claude subscription, not per-token API pricing), so it's independent of the checks above and
doesn't gate merges:

```bash
npm run build
npm run typecheck
npm test                 # core + ai + server + web Vitest suites, ~10s
```

E2E:

```bash
npm run test:e2e                             # Playwright smoke — boots the BUILT server
                                             # (run `npm run build` first); set
                                             # CHROMIUM_PATH=/path/to/chromium to reuse a browser
node scripts/e2e.mjs http://localhost:3000   # full scripted tournament (needs DEV_AUTH=1)
```

Server tests never bind a port: `buildApp()` in `server/src/app.ts` returns an un-listened
Fastify app, and suites drive it in-process with `app.inject()` against a temp `DB_PATH`
(see `server/test/helpers.ts`). Follow that pattern for new server tests.

### Environment variables

| Var | Default | Purpose (where it's read) |
| --- | --- | --- |
| `PORT` | `3000` | listen port (`server/src/index.ts`) |
| `BASE_URL` | `http://localhost:3000` | public URL; OAuth redirect + secure-cookie flag (`auth.ts`), `Sitemap:` line in `robots.txt` (`app.ts` — validated as an absolute http(s) URL there, because Vite defines a `BASE_URL` of its own that Vitest puts on `process.env` as `/`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth (`auth.ts`) |
| `DEV_AUTH` | off | `1` enables `POST /auth/dev` name-only login (`auth.ts`) — **never on the production app** (previews + the demo app are deliberate exceptions) |
| `DEMO` | off | `1` enables demo mode: `GET /demo` auto-login, `/api/demo/*` scenario + reset routes, boot seeding (`demo.ts`, `auth.ts` for the `/api/me` flag, `index.ts` for the seed gate) — **never on the production app** (CI enforces this, see invariant 5; previews + the demo app are deliberate exceptions) |
| `DB_PATH` | `./data/bridge.db` | SQLite file; dir auto-created (`db.ts`) |
| `AI_MODEL` | `sl` | `sl` (SAYC-faithful) or `rl-fsp` (stronger, drifts from SAYC) (`game.ts`) |
| `AI_PLAYERS` | on | `0` disables the benchmark AI personas' background play + boot sweep (`ai-players.ts`) — set by the server test harness (`server/test/helpers.ts`) so suites exercising `placeUser` don't play 12 bot boards per placement |
| `AI_PAUSE_MS` | `15000` | how long after an interactive API request the personas' non-urgent play stays parked (`ai-players.ts`); tests set `0` |
| `LOG_LEVEL` | `info` | Fastify logger (`app.ts`) |
| `WEB_DIST` | `../../web/dist` | override static SPA path (`app.ts`) |

## Architecture essentials

**A move, end to end:** client `POST /api/tournaments/:id/boards/:no/call` (or `/play`) →
`requireUser` → `loadBoard` re-deals the board deterministically from the tournament's stored
`seed` + board number → `submitCall`/`submitPlay` validates turn and legality →
`advanceRobots` loops, applying deterministic robot bids/plays until it's the human's turn or
the board ends → state saved to SQLite → if the board completed, `recomputeElo()` →
response is `boardView`, which **redacts hidden hands** (dummy only after the opening lead).
Never return raw board state to the client. Because one response can carry a whole burst of
robot plays, the client doesn't apply it in one jump: `web/src/components/game/playAnim.ts`
stages the transition into timed snapshots (card-by-card glides, trick collect, tally stamp)
that `Board.tsx` applies on timers and `TrickArea.tsx` animates — server data is untouched,
so anything that changes what a response *contains* should keep `stagePlaySteps` in mind.

**Auto-play and claims:** two QoL layers sit on top of the flow above, both client-driven so
the server stays a plain request/response API. When `boardView.legalCards` has exactly one
card, `Board.tsx` plays it automatically after a short delay (`AUTO_PLAY_DELAY_MS`) instead of
requiring a tap — it just simulates the second tap of the normal select-then-confirm flow.
Separately, `advanceRobots` (`server/src/game.ts`) runs a double-dummy solve
(`solveFutureTricks` in `packages/ai/src/play-ai.ts`) at every real decision point; the instant
either side is DD-confirmed to win 100% of the remaining tricks, it marks the board `claimed`
and plays out the rest via `chooseCard` for both sides — a claim is just "the server fast-plays
a predetermined tail," not a distinct completion path, so scoring/`finishBoard`/Elo are
untouched. The client detects a claim from `boardView.claimed` + `playHistory` (no extra fields
needed to know which side or how many tricks — see `claimAnnouncement` in `playAnim.ts`); rather
than starting the fast-forward the instant a claim is detected (easy to miss, since the old
announcement banner popped up alongside cards already in motion), `Board.tsx`'s `runClaim` holds
the board on a modal `ClaimOverlay` for `CLAIM_ANNOUNCE_HOLD_MS` — tap, click, or Escape
dismisses early — before the remaining tricks play out through a separate `stageClaimSteps`
staging function (kept apart from `stagePlaySteps`, which assumes at most one trick boundary per
response — a claim can span many), reusing the same glide-in/collect machinery `stagePlaySteps`
uses for ordinary play but at `CLAIM_SPEEDUP_FACTOR` pacing (33% faster than the claim's already-
compressed base gaps), before handing off to the normal completion view. The hold applies
whether or not motion is on — without a fast-forward to animate afterward there's nothing to
hold the announcement up *for*, but it still deserves its full, dismissible read before jumping
straight to the result. Because the solve only runs at a decision point with more than one legal
card, the trick already in progress when the client's last request went out can still finish for
either side before the guaranteed run of claim tricks begins — `claimAnnouncement`/
`stageClaimSteps` tally each newly-completed trick by its actual winner rather than assuming the
whole batch belongs to the claiming side. See invariant 1 below — claims change what
`advanceRobots` records for a human's untaken decisions, so they interact directly with the
robot-trace fixture.

**Robot difficulty (sampled-DD play):** difficulty is a **per-board** property — the
duplicate-fairness unit is the board, so every player on (tournament, board) faces the same
tier, resolved by `boardDifficulty()` in `tournaments.ts` from two tournament columns:
`difficulty` (the placement-tier label) and `board_difficulties` (JSON `Difficulty[4]`, NULL
= uniform at the label). `placeUser` stamps both from the creating user's preference
(`users.difficulty`, default `'intermediate'`, set via `POST /api/me/difficulty` — backend
only, no web UI yet); today's schedules are always uniform, so ramps/mixed schedules are a
data change. Placement only matches users into tournaments of their preferred tier (resume
of an already-started tournament is deliberately preference-blind). The player-facing tiers
(`MC_SAMPLES` in `difficulty.ts`) all use `chooseCardSampled` (`packages/ai/src/play-mc.ts`)
— K seeded layouts of the cards the acting player can't see, constrained by shown-out voids
and (unless the tier is auction-blind) the auction's machine-checkable SAYC `req`s with a
deterministic relaxation ladder, each solved double-dummy, aggregate scores summed per legal
card, then (per `PLAY_NOISE`, see "Robot difficulty (card-selection noise)" below) either the
flat best card played or a seeded weighted pick among the top few:
`expert` kOpp=8, `intermediate` kOpp=1, `beginner` kOpp=1 **auction-blind** (opponents
ignore the bidding entirely). Robot North — only ever the human's defensive partner — is
always auction-aware at `kPartner = max(kOpp, PARTNER_FLOOR=8)` and never subject to
`PLAY_NOISE` (always the flat best card). The fourth value,
`'perfect'`, is the **hidden legacy tier**: true-deal DD-optimal play, byte for byte the
pre-difficulty behavior; it's the schema default (so legacy tournaments, the robot-trace
fixture, and demo exhibits all resolve to it) and is not settable through the API. Demo
ambient tournaments are stamped `'intermediate'` so default-preference placement joins them.
Claim detection and `resolveClaim` stay true-DD at every tier. Sampled solves run through a
lazy `worker_threads` DDS pool (`dd-pool.ts`, one WASM instance per worker, sequential
fallback when unavailable); DDS is deterministic, so the pool affects latency only. Nothing
here consults env vars — difficulty flows from the tournament row.

**Robot difficulty (bidding noise):** card play softening above only ever touched hidden-hand
uncertainty — bidding (`bidder.ts`) was difficulty-blind, every tier bidding the model's pure
argmax over SAYC-admissible calls. `BID_NOISE` in `difficulty.ts` gives bidding its own,
independent dial: at any non-`'perfect'` difficulty, `Bidder.chooseCall` draws (seeded via
`bidDecisionSeed`, the same duplicate-fairness argument as `mcDecisionSeed`) from the top
`BID_NOISE[tier].topN` SAYC-admissible calls weighted by the model's own probabilities, instead
of always taking the single highest-probability one. `topN: 1` (expert) is mathematically
identical to pure argmax — expert bidding, and every `'perfect'`-tier or no-`opts` call site
(the robot-trace fixture, `tools/calibrate_k.mjs`'s baseline bidding, `tools/gen_trace_fixture.mjs`),
is untouched. `server/src/game.ts`'s `advanceRobots` is the only production call site that
passes `opts`, resolving `difficulty` the same way `robotCard()` does
(`boardDifficulty(b.tournament, b.row.board_no)`). Calibrated the same way as `MC_SAMPLES`
(`tools/calibrate_k.mjs --bid-topn`, see `difficulty.ts`'s doc comment for the table) — the dial
saturates by topN≈3, same shape as the K dial.

**Robot difficulty (card-selection noise):** K and `BID_NOISE` above only ever corrupt the
acting player's *belief* about the hidden cards — `chooseCardSampled` still always played the
single highest-scoring legal card against whatever it sampled (a pure argmax via
`pickFromSolve`). `PLAY_NOISE` in `difficulty.ts` softens the *decision* itself instead: an
optional `playTopN` on `chooseCardSampled`'s opts (default 1, byte-identical to every
pre-existing call site) draws, continuing the same seeded rng stream used for hidden-hand
sampling, from the top `playTopN` legal cards weighted by the K-sampled layouts' own score,
instead of always the best one — the same idea `BID_NOISE` applies to bidding, applied to card
play. `server/src/game.ts`'s `robotCard()` passes `PLAY_NOISE[difficulty].topN` for E-W and `1`
for robot North (never noisy, matching its `kPartner`/always-auction-aware treatment). Per
research (`docs/difficulty-calibration-research.md` §7c/7d), this is the largest lever found
for the beginner/intermediate tiers — `K` is floored at 1 and `BID_NOISE` saturates by
topN≈3-4, but `playTopN` keeps adding real effect further out, and unlike raising `K` it costs
no extra DDS solves (it re-weights totals the K-sample solve already computed). Calibrated via
`tools/calibrate_stats.mjs playtopn`; `tools/calibrate_stack.mjs --ew-only` measures the
combined bid+play effect against a pure/true-DD reference with only East/West weakened
(matching `PARTNER_FLOOR`'s asymmetry), instead of that tool's default of weakening all four
seats and reporting an unsigned delta. `intermediate` ships with `PLAY_NOISE` fully OFF
(`topN: 1`, same as expert) — measurement showed beginner and intermediate landing within
noise of each other in that combined metric even though each dial moved monotonically in
isolation, and hardening intermediate closed that gap far more efficiently than pushing
beginner further (`tools/calibrate_whatif.mjs`'s comparison, and the full reasoning, are in
`PLAY_NOISE`'s doc comment and `docs/difficulty-tuning-guide.md`). See that guide for the
general mental model (belief dials vs. decision dials, why they saturate differently, which
tool answers which question) before tuning any of these constants further.

**Benchmark AI players ("the house"):** three permanent `users.kind = 'ai'` personas —
"The Novice", "The Regular", "The Shark" (`server/src/ai-players.ts`) —
automatically play every tournament stamped `tournaments.ai_field = 1` (set at creation by
`placeUser` and demo-seed's ambient tournaments; never backfilled, so legacy/fixture/exhibit
tournaments never acquire AI rows). Each persona plays the human seat through the real engine
(`bot-play.ts`'s strategy-injected loop → `submitCall`/`submitPlay`), so it faces the board's
robots exactly as a human would; its own decisions carry every dial of its tier —
`BID_NOISE` bidding, `MC_SAMPLES` belief (`kOpp`/`auctionAware`), `PLAY_NOISE` card
selection — under a persona-namespaced seed (`${seed}:ai:${tier}`), making its boards a pure
replayable function of (tournament seed, board, tier, board difficulty). Defending, its robot
partner North keeps the human `PARTNER_FLOOR` treatment on purpose: the benchmark means "a
player of tier X in your chair," expert-partner boon included. Personas are **full
matchpoint field members**: `standings()`/`boardResult()`/`myBoardSummaries()` score everyone
— humans and house — in one field per board, so house rows earn real ranks, count in pair
counts, and move human pcts like any other pair (beating The Shark is worth matchpoints);
the web still renders them muted-italic with a HOUSE tag (never the "you" surface fill).
The human/persona split survives in exactly three places: **Elo** — personas never rate, and
the replay's inputs come from `eloParticipants()` (human-only matchpointing, deliberately
distinct from the displayed pcts) so house scores can't shape a human rating even indirectly
(matchpoint averages aren't order-preserving under field insertion), persona completions skip
the recompute, and persona profiles hide every Elo surface; **placement** — grace/popularity
counts are human-only (`stmtCandidates` counts human board rows only — without this, three
instant AI finishers would close every grace window); and the **leaderboard** (Elo-sorted,
so personas have nothing to rank by). Their `/players/:id` profiles stay open as calibration
content, and their scores/bid evals count in the stats percentile pools like anyone else's. **Scheduling is
demand-driven and human-first** (persona play is CPU-heavy DDS solving): work is unit-granular
(one persona × one board, board-major) on a single runner; units a recently-active human will
need soon — within `LOOKAHEAD_BOARDS` of the furthest human's next board in a tournament
that saw a board request in the last ~10 min — run immediately (which is why house scores
always exist by the time a human finishes a board), while everything else parks whenever any
interactive API request landed within `AI_PAUSE_MS`; even urgent units yield
decision-by-decision to in-flight human taps (`courtesyGap` — personas solve inside the
human's think-time gaps, capped so they always make progress, disabled when `AI_PAUSE_MS=0`).
Play starts when a human is placed into
or opens a board of an `ai_field` tournament (never speculatively at boot); `index.ts`'s boot
sweep re-enqueues only started-but-incomplete tournaments (crash recovery), and
`bot-play.ts`'s per-board wipe-unfinished-then-replay keeps interrupted boards
byte-identical. Demo mode: ambient tournaments are stamped `ai_field = 1` but get house rows
on demand when a tester lands in one (playing all of them at every boot/reset cost ~25 min of
full-core compute); `/api/demo/reset` suspends the runner across the wipe
(`withAiPlayersSuspended`) and re-creates the personas afterward.

**Deployment shape:** one container. The built server statically serves `web/dist` and
falls back to `index.html` for non-`/api`/`/auth` routes. SQLite on a single volume means
**exactly one machine** — no horizontal scaling. On Fly.io this means every environment
(production, the permanent demo app, and each per-PR preview) is its own separate app with its
own volume — `fly.toml` is shared across all of them, with the app name always overridden
per-environment via `--app` in CI (see `.github/workflows/ci.yml`'s
`deploy-preview`/`deploy-demo`/`deploy-production` jobs).

**Tournaments never close** (evergreen): `placeUser` in `tournaments.ts` resumes your
unfinished tournament first. Otherwise it serves a candidate from the last 30 days you
haven't played, in two tiers: a **grace window** force-joins young (< 48h), under-filled
(< 4 starters) tournaments so fresh ones collect a field instead of orphaning; then
candidates are scored `log(1 + distinct finishers) · e^(−age/τ)` and one is weighted-random
sampled from those near the top score. If nothing beats what a brand-new tournament would
score (`ln 2`), a new one is created — which the grace window then fills. All knobs live in
the `PLACEMENT` const in `tournaments.ts`. Tournaments older than the window are archived
from placement but stay resumable and completable via direct URL (boards deal lazily), and
still count in the Elo replay. Full design rationale: [TOURNAMENT-SELECTION.md](TOURNAMENT-SELECTION.md).

**Demo mode (`DEMO=1`, PR previews + the permanent demo app at demo.bridge.brannon.online):**
the preview comment's `/demo` link (or the demo app's `/demo` URL) signs the
visitor in as a shared "Inspector" persona and lands on `/scenarios` — a gallery of
"exhibits" that jump straight into hard-to-reach game states for click-testing. An exhibit
is a replay recipe (seed + board + scripted human actions, `server/src/scenarios.ts`)
executed through the real engine per user, deliberately stopping one action short of
delta-driven UI (grade toast, claim fast-forward, live receipt) so the tester triggers it
live. Exhibit tournaments carry `kind = 'exhibit'` (a `tournaments` column defaulting to
`'standard'`, see `db.ts`), which excludes them from placement and the lobby list
(`tournaments.ts`), from the Elo replay (so they can never rate, even if fully played out by
URL), and from stats/leaderboard sweeps (`stats.ts`, `app.ts`) — all filters inert in
production, where every tournament is `'standard'`. A boot
seeder (`demo-seed.ts`, async after listen) plays bots through backdated tournaments to
populate leaderboard/stats/placement tiers, and `POST /api/demo/reset` wipes + reseeds
(wipes and seeds share one queue, so they never interleave). Bot-driven board play
(`playBoard`/`playThrough` in `bot-play.ts`) is shared between the ambient seeder and any
scenario that needs boards pre-completed before the tester arrives: a `completesTournament`
scenario (the `results` category's `tournament-complete`) pre-plays the acting user through
its earlier boards and seeds bots through the whole tournament, so finishing the last board
live reveals a genuine tournament-summary screen instead of just one board's receipt. Two
`GET /api/demo/scenarios` fields back client-only, non-scripted gallery rows: `newCrosserId`
(a permanent, never-played persona for the stats page's cold-start empty state) and
`richProfileId` (a populated bot's profile, paired with it for contrast); `collisionHandle`
(the New Crosser's own handle) prefills the handle-picker exhibit so its "already taken"
error is guaranteed to fire on the first submit.
One gallery entry is not a replay recipe: `fresh-house-crossing` (`freshAiField`) mints a
brand-new STANDARD `ai_field = 1` tournament per click and lands the tester on board 1, so
the benchmark AI personas can be click-tested exactly as production behaves (exhibit-kind
tournaments deliberately never get AI rows, so a canned exhibit couldn't show this).
Recipes are mined offline with `tools/find_scenarios.mjs` and checked in; demo mode also
suppresses the automatic returning-visitor splash and the automatic first-crossing tour
(`App.tsx`) — the tour is click-testable from its FRONT DOOR gallery row, which opens
`/tour`. **Shipping a new
hard-to-reach or delta-driven UI state ⇒ add or update an exhibit in `scenarios.ts`** (mine
the recipe with the tool, label it from the tester's point of view) — the drift-guard test
keeps existing exhibits honest, but only this rule keeps the gallery covering new features.

**The first crossing (onboarding):** a new account gets the toll office's pamphlet before
the app — a cover ("Welcome to the bridge."), the philosophy panel (I · THE BRIDGE), and
duplicate as a specimen ledger (II · THE LEDGER), a quiet "skip the tutorial" fine-print
link at the foot of every page — then the tollkeeper's practice board. `users.onboarded_at`
NULL makes `App.tsx` render `pages/Tour.tsx` in place of the routes, but only when the
session *arrived* at the main app (`/`, captured once at mount): a deep-link arrival goes
straight to its destination and meets the tour on a later home arrival instead, and
navigating home mid-session never springs it. `POST /api/me/onboarded` (write-once, stamped
on finishing *or* skipping) ends the gate; existing accounts were grandfathered as onboarded
by the migration, demo mode suppresses the automatic gate like the splash, and `/tour` stays
routed for replays — the Glossary files it as a ledger term (the 'First crossing' easter
egg, aliased "app tour", whose sheet links there via terms.ts's `action` field) and demo's
Exhibit Hall row points there too. The tour's practice board (`web/src/onboarding/`) is **not a server
board**: `tools/gen_tour_board.mjs` drives the real engine offline — model-argmax human
calls (so every grade toast honestly reads "the robot's choice too"), DD card play, real
SAYC meanings on every legal call, and the three benchmark personas genuinely playing the
same deal at their tiers for the field — and captures every decision-point `boardView`
into `board0.json` (lazy-loaded). Because the capture is driven by the SAME in-memory
`GameBoard` throughout, it also correctly preserves a genuine claim if this deal's contract
resolves early (`b.claimed` has no persisted DB column — a naive reload after the
persona-play step would silently lose it and turn the tail into an unanimated cut straight
to the ledger, which is exactly the bug that shipped before this was fixed; see the tool's
doc comment). `Tour.tsx` replays those views through Board.tsx's exported
`BiddingPhase`/`PlayPhase` (the literal board UI, plus the tollkeeper narration ribbon and
an optional `hint` pulse threaded through BidBox/HandFan), staging ordinary robot bursts
with the same `stagePlaySteps` the live board uses and a captured claim tail with the same
`ClaimOverlay` + `stageClaimSteps` fast-forward `Board.tsx` uses (see "Auto-play and claims"
above); off-script selections show their real meanings but only the scripted line commits,
and the tail past the curated steps self-plays — a forced-but-guided step (one with real
narration to read) gets a full `GUIDED_FORCED_DELAY_MS` beat rather than the live board's
near-instant auto-play delay. That beat is *reading* time, so unlike the tail's pacing it
survives `prefers-reduced-motion` (asking for less movement isn't asking to be taught
faster) — the same split applies to the tollkeeper ribbon, where only the ink-wash overlay
remounts per line so the `role="status"` region itself stays put for assistive tech.
Because the tour renders in place of the routes, two things that are plain links on a live
board have to be re-pointed: `ScoreReceipt`'s "Back to lobby" takes an `onLeave` override
(wired to the tour's skip, which stamps the gate), and the capture's views are renumbered
to board №0 in `loadTourBoard` so the receipt's "THE TOLL — BOARD n" heading agrees with
the №0 chrome around it (the capture itself runs on board 3, dealer South, and stays
exactly as the engine emitted it). Narration lives in `onboarding/script.ts`, hand-curated
against the capture — `onboarding/tour.test.tsx` is the drift guard that forces re-curation
if the capture is regenerated onto a different line (including the field outcomes
`COPY.fieldSay` names by hand). Every line of the tour's own voice
(pamphlet body copy and the tollkeeper's ribbon, but not its display type) renders through
`GlossaryProse` under `script.ts`'s `TOUR_LINKS` policy, so the words a first-timer is
meeting for the first time open the term sheet — which means the gate-rendered tour needs
its own `GlossaryProvider` in `App.tsx`, since it renders in place of the routes the app-wide
one wraps (a sheet lives in `?term=`, leaving the path alone, so opening one never disturbs
the arrival gate).

**Elo is recomputed from scratch** every time a board completes: `recomputeElo` wipes
`elo_history`, resets everyone to 1200, and replays all tournaments **in tournament-id
order** (not timestamps). That's deliberate — a late finisher in an old tournament re-ranks
everyone — so don't "optimize" it into an incremental update without redesigning the model.

**Hand-flip subtlety:** the human sits South, but when North (the robot partner) declares,
the human plays the North hand — see `humanControls` and the `flipped` handling in
`game.ts`/`boardView` and the Board page. Touching seat/turn logic? Test both orientations.

**better-sqlite3 is synchronous:** DB calls are not awaited; prepared statements live as
module-level constants next to the functions that use them. Match that style.

**Night mode is a token swap, not per-component dark styles.** `[data-theme="night"]` on
`<html>` overrides the base color tokens in `style.css` (`--ink`, `--paper`, `--panel`,
the suit triad, etc.); everything built on those via `var()` — including the semantic
aliases and the ink-plate components (`FlipDigits`, `HcpBadge`, selected bid buttons,
`.ds-btn.btn-primary`) — repaints automatically. Playing-card faces are a fixed paper/ink
plate by day (`--cardface`/`-ink`/`-line`/`-suit-*`, stark white with pinned dark ink), but
night overrides the whole set to an "ink-plate negative" — dark stock (`#2b2620`), light
ink/suits borrowed from the night `--ink`/`--suit-*` triad via `var()` — rather than just
dimming the paper color, the same idea already applied to `.ds-btn.btn-primary` turned
around: there, a light plate keeps dark (daytime) suit glyphs at night, so
`--onprimary-suit-*` had to stop referencing `--cardface-suit-*` and spell out that daytime
triad literally once `--cardface-suit-*` itself started flipping to light colors at night.
Deliberately low luminance contrast against `--panel` — the card reads by its border and
glyphs, not a bright rectangle, the opposite trade-off from the daytime card. The
`BridgeMark` glyph/footer stays fully pinned (already `var(--verdigris)`, lifted to its
night value like any other token). Default is `prefers-color-scheme`, no
attribute set; the Stats page's Day/Night/Adaptive/System switch (`theme.ts`, `nb:theme`
in localStorage) sets `data-theme` explicitly to override it, or clears it for "System".
"Adaptive" is also an explicit override (there's no media query for time-of-day): it
resolves to night on a fixed local-time window, `ADAPTIVE_NIGHT_START_HOUR`–
`ADAPTIVE_NIGHT_END_HOUR` in `theme.ts` (9 PM–7 AM, the industry-standard fixed
dark-mode schedule — e.g. Windows Night Light's default "set hours" — rather than a
sunset/sunrise calculation, since that needs geolocation this app doesn't request); a
60s timer in `App.tsx` re-applies it so a tab left open across the boundary still flips
live, the same problem `system`'s `matchMedia` listener solves for OS changes. A
blocking inline script in `web/index.html` applies the persisted choice before first
paint — keep it in sync with `theme.ts` by hand, since it has to run before the module
graph loads. The `@media (prefers-color-scheme: dark)` copy of the night token block is
scoped to `:not([data-theme])` so it never fights an explicit override — if you add a new
base token, add it to both the `[data-theme="night"]` block and that media copy.

**The glossary is static client data — no server, no API.** `web/src/glossary/terms.ts`
holds the ~124 curated core terms (slug, final definition copy, the brief's seven themes,
search/link aliases, related slugs); `deep.json` is the generated "deep reference" — the
full Wikipedia bridge glossary as one-liners (regenerate with `tools/gen_glossary_deep.mjs`,
which also dedupes against core) — lazy-loaded via the web bundle's only dynamic import.
Both are CC BY-SA 4.0 adaptations, so the `Attribution` credit must stay on the Glossary
page and every term sheet. Deep linking works in two directions: `GlossaryProse`
(components/game) renders prose with core terms tappable — it wraps `SuitText`, and is what
the meaning panel, call inspector, grade toast, and receipt captions render through — and
`/glossary/:slug` routes open the same sheet from a URL (they normalize, via replace, to
the live mechanism: a `?term=<slug>` search param on whatever route you're on). The sheet
mounts once, app-wide, from `GlossaryProvider` (App.tsx); `useGlossary().openTerm(slug)`
PUSHES a history entry carrying its chain depth in `location.state`, so browser
back/swipe unwinds nested related-term taps one sheet at a time while ✕/scrim/Escape
pops the whole chain in one `navigate(-depth)` (a cold load arriving with `?term=` set
just strips the param with a replace). Linkifier noise is tuned in data, not code:
`linkify: false` in terms.ts keeps ultra-common words (bid, pass, game…) unlinked, and
`segmentProse` links only the first occurrence per block. That sitewide flag is calibrated
for *gameplay* prose; a teaching surface can pass `segmentProse`/`GlossaryProse` a
`LinkPolicy` instead — `force` re-links a few of those common words, `skip` drops one the
matcher reads in the wrong sense, `omit` is the existing self-link guard — which is how the
first-crossing tour links "trumps"/"trick"/"game" (`TOUR_LINKS` in `onboarding/script.ts`)
without turning bid copy into a link farm. `web/src/glossary/glossary.test.ts` guards the
data invariants (unique slugs, resolvable
relateds, core/deep disjointness). The bottom TabBar is the "turnstile" nav pattern:
tabs share the width while they fit, and only overflow into the horizontal scroll (right
fade + chevron, active tab auto-centers) once the gates outgrow it — so future gates fit
without a hamburger.

**Discoverability: the glossary is the front door from search.** Everything else in the
app needs an account, so a crawler saw exactly one URL — a login splash carrying ~20 words
of deliberately cryptic copy. Three pieces changed that, and they only make sense together:

- **The routes are public.** `isGlossaryPath` in `App.tsx` renders `/glossary` and
  `/glossary/:slug` for a signed-out visitor instead of `<Login />`, with `ds/SignInBar`
  in the TabBar's slot (every other tab needs an account). Nothing is un-gated but static
  reference data — no board state, no standings, nothing user-scoped. `TermSheet` hides a
  term's `action` link when signed out, since those point at gated screens (`/tour`).
- **They're prerendered.** The app is client-rendered, so a crawler that doesn't run JS
  (Bing, DuckDuckGo, most social and LLM crawlers) still saw an empty `#root`.
  `tools/gen_glossary_static.mjs` runs after `vite build` and emits one static page per
  core term into `web/dist/glossary-static/`, each a copy of the built `index.html` with
  the `seo:start`/`seo:end` head span swapped and `#root` filled. The module script is
  copied through untouched, so a human following a search result still boots the ordinary
  SPA over it (React clears `#root` on mount — the markup is a fallback, never a second
  copy of the UI to maintain). `app.ts` serves those files ahead of the SPA fallback, by
  membership in a `Set` of emitted filenames rather than by joining the raw slug onto a
  path. Deep-reference entries deliberately get no page of their own: they're close
  paraphrases of Wikipedia's glossary, so indexable prose for them would be thin,
  duplicative content competing with the source we adapted.
- **Throwaway origins stay out of the index.** The demo app and every PR preview serve a
  byte-identical build from their own hostnames, so without this the index fills with
  duplicates that outrank production and hand searchers a database that gets wiped.
  `DEMO=1` or `DEV_AUTH=1` (invariant 5 forbids either in production) flips `robots.txt`
  to disallow-all *and* adds `X-Robots-Tag: noindex, nofollow` to every response — the
  header is the one that matters, since a preview link posted in a PR is inbound-link
  enough to get a URL indexed without ever being fetched.

Two things to keep in mind when editing. `web/index.html` must keep its `seo:start`/
`seo:end` markers and its `<div id="root"></div>` exactly as they are — the prerender
throws if either goes missing, so a rename fails the build rather than silently shipping
125 pages of generic metadata. And the shell deliberately carries **no**
`<link rel="canonical">`: it's served for every unprerendered route, so a static canonical
would tell crawlers that every deep link "is really" the home page. Prerendered pages
carry their own correct self-canonical; everything else self-canonicalizes by default.
Adding a new public route means adding it to the sitemap in `gen_glossary_static.mjs`.

## Invariants — do not break

1. **Robot determinism is the fairness invariant of the whole product.** Bidding is model
   argmax; card play at the hidden legacy `'perfect'` tier is DD-optimal with a deterministic
   tie-break, and at the player-facing tiers it is sampled-DD (`play-mc.ts`) — fallible by
   design but still a pure function of (board difficulty, tournament seed, board, public game
   state, tier constants); deals derive from the tournament seed. Every player must face
   identical robots on identical deals or duplicate scoring is meaningless. The trace fixture
   `server/test/fixtures/robot-trace.json` guards the perfect path (every fixture/exhibit
   tournament is perfect by default). If you *deliberately* change robot behavior (model,
   encoding, tie-breaks, dealing), regenerate it: `npm run build && node
   tools/gen_trace_fixture.mjs`. If that diff surprises you, you were about to silently break
   comparability of live tournaments — stop and figure out why. Changing the sampled-tier
   constants (`MC_SAMPLES`/`PARTNER_FLOOR`/`BID_NOISE`/`PLAY_NOISE` in
   `packages/ai/src/difficulty.ts`) is the same kind of deliberate robot change scoped to
   non-perfect tournaments: it breaks comparability for in-flight ones, so calibrate
   (`tools/calibrate_k.mjs`, `tools/calibrate_stats.mjs`, `tools/calibrate_stack.mjs`) first,
   or accept the break knowingly. Laydown claims are a legitimate, *expected* source of fixture diffs even without
   touching robot behavior: once a board becomes DD-determined, its tail switches from the
   fixture's "first legal card" human strategy to `chooseCard`'s DD-optimal play, which can
   reorder (not rescore) the end of `plays`. Still eyeball the diff — confirm it's exactly that
   reordering and the score is unchanged — before accepting a new fixture. The demo-mode
   scenario recipes in `server/src/scenarios.ts` are replay-sensitive the same way: a
   deliberate robot change breaks them and `server/test/scenarios.test.ts` fails — re-derive
   the action lists with `node tools/find_scenarios.mjs` and re-curate the copy by hand.
   The onboarding capture `web/src/onboarding/board0.json` is replay-sensitive the same
   way: regenerate it with `node tools/gen_tour_board.mjs --seed crossing-43 --write` (or
   re-mine with `--search`) and re-curate `script.ts` until its drift-guard test passes.
   The benchmark AI personas (`ai-players.ts`) sit on both sides of this invariant: their
   boards are deterministic replays of the same machinery, and because house scores now count
   in everyone's matchpoints, a deliberate robot/tier change retroactively moves *human* pcts
   and ranks in affected tournaments too — accepted, same scope, one more reason to
   calibrate before touching the tier constants. The one guarantee that remains absolute is
   Elo: the replay's inputs are human-only (`eloParticipants`), so house play can never move
   a rating — `server/test/ai-players.test.ts` deletes every AI row and asserts
   `elo_history` is byte-identical.
2. **`packages/ai/src/encode.ts` is a bit-for-bit port** of the pgx `bridge_bidding`
   observation encoding, verified by golden tests against the original JAX output. Do not
   refactor it for style. Regenerating `packages/ai/test/fixtures.json` is only needed if the
   encoding or model weights change, and requires a Python venv with pinned jax — see the
   docstring in `tools/gen_fixtures.py`.
3. **New SAYC convention ⇒ new spec-table row** in `packages/core/test/sayc.test.ts`.
4. **`packages/core` stays dependency-free and I/O-free** — pure rules. The server imports
   it; the web bundle deliberately does not (it mirrors the few helpers it needs in
   `web/src/api.ts` and receives anything score-shaped pre-computed from the server).
5. **`DEV_AUTH=1` and `DEMO=1` must never be set on the production app (`nickel-bridge`)** —
   the former is unauthenticated login, the latter hands out sessions and can wipe the
   database. CI's `deploy-production` job refuses to deploy if either secret exists on the
   production app. PR previews and the permanent demo app (`nickel-bridge-demo`) are separate
   apps with their own throwaway databases where both flags are intentional.

## Design system

The visual identity — 1920s toll bridge: ink-on-paper palette, Poiret One/Crimson
Pro/Besley type, toll vocabulary ("PLAY THE TOLL", "PREVIOUS CROSSINGS"), ticket/stamp/
postmark motifs — lives as a Claude Code skill in `.claude/skills/nickel-bridge-design/`
(exported from Claude Design): brand rules in its `readme.md`, CSS tokens, guideline
specimens, SVG marks, and reference JSX components.

**Use the `nickel-bridge-design` skill for any UI work** — new screens or components,
changes to `web/src/style.css`, user-facing copy, mocks and prototypes. Its `readme.md` is
the source of truth for visual and voice decisions (`docs/design-brief.md` is the
requirements spec it grew from). The skill's JSX components are prototyping references, not
imports: production equivalents live in `web/src/components/ds/`, and styles get ported into
`web/src/style.css`. Note the skill's demo HTML uses Google-hosted fonts via `@import`;
production self-hosts the same faces via `@fontsource`.

## Player outreach

`.claude/skills/player-outreach/` is operator tooling, not part of the build — it lives in
a skill rather than `tools/` because it needs `FLY_API_TOKEN` and touches production. Its
`scripts/player_report.mjs` is the **only** supported way to read the live player roster:
there is no analytics stack and no admin API, so it execs a read-only (`readonly: true`)
SQLite query on the production machine via the Fly Machines API and emits a roster CSV/JSON
with each player bucketed into `retained` / `friction` / `abandoned_first` / `never_played`.
The skill then drafts the weekly outreach emails through the Gmail connector — which can only
*draft*, never send, so a human reads every word first.

`abandoned_first` (opened a board, never finished one) carries `stopped_at` and `human_calls`,
derived from the board's `calls`/`plays` arrays plus core's seat rules — seats `0=N 1=E 2=S
3=W` with the human always South, `dealer = (boardNo - 1) % 4`, seat `(dealer + i) % 4` on call
`i`. That yields "left without ever bidding", which the outreach states to a real person, so
keep it derived from those rules rather than re-guessed.

Two things to know before touching it. **`boards_done` is not the leaderboard test**: the
leaderboard gates on `rated_tournaments >= PROVISIONAL_MIN_TOURNAMENTS` (4), and a
tournament only rates a player who finished all four of its boards in a field of 2+ humans
— so 16 finished boards spread across half-played tournaments still means no leaderboard
row. `references/data-model.md` in the skill explains the gap. And **this repo is public**,
so roster output (real names and email addresses) must never be written into the working
tree, committed, or published to an Artifact — the skill writes those to the session
scratchpad.

Nobody gets emailed twice because three sources are unioned before drafting: the skill's
`contacted.json` ledger, Gmail's sent mail (`in:sent subject:"nickel bridge"`, **paginated**),
and pending drafts. The ledger is committed here and is safe to be, because it holds only
`user_id`/`cohort`/`sent_on` — opaque row ids, meaningless without the production database, and
deliberately not handles or addresses. It's written only after a send is confirmed, so a draft
that gets reviewed and deleted correctly returns to the next batch; Gmail covers the opposite
gap, where a send happened but nothing was recorded.

## Unattended outreach permissions

`.claude/settings.json` exists for exactly one reason: the weekly player-outreach routine
(`.claude/skills/player-outreach/`) fires into a fresh, non-interactive session, and a session
that can't answer a permission prompt simply stalls at it. Every rule in that file is scoped to
that workflow. It is checked in so the routine behaves identically for anyone who runs it,
rather than depending on one person's local approvals.

Three groups, and the reasoning matters more than the list:

- **The roster script.** `Bash(node .claude/skills/player-outreach/scripts/player_report.mjs *)`
  plus an `autoMode` rule, because this is the one step that execs on the production machine.
  The allowance is deliberately narrow — that exact script, any of its flags — and the
  `autoMode` entry spells out *why* it's safe (read-only SQLite handle, fixed SELECT, no argv
  in the SQL) so the next reader can re-evaluate rather than trust. **Don't widen it into a
  general exec-on-production allowance**, and re-check it if the script changes.
- **Gmail reads.** `search_threads`, `list_drafts`, `get_thread`, `get_message`, `list_labels`.
  Two of the three dedupe sources above live behind these, so blocking them is the *less* safe
  option: a run that can't check who's been contacted either stops or guesses, and guessing
  wrong means emailing people twice.
- **Gmail drafts.** `create_draft` and `update_draft`. Safe to automate only because the
  connector exposes **no send capability whatsoever** — the worst case is drafts a human deletes.
  That human review is the safety boundary of the whole workflow.

`permissions.deny` explicitly blocks the trash/spam labellers (`apply_sensitive_*_label`) and
`delete_label`. The skill never needs them, and an unattended agent should not be one
mis-selected tool away from moving someone's mail to spam.

Two things this file does **not** grant, on purpose: sending mail (impossible via the connector
today — if that ever changes, adding a send tool to `allow` must be a deliberate, separately
reviewed decision, not an oversight), and any other production exec. `autoMode.allow` starts
with `"$defaults"` so the built-in classifier rules still apply underneath.

## Code style

There is no linter or formatter configured; TypeScript strict mode and tests are the gate.
Match the surrounding code: 2-space indent, single quotes, no semicolon-avoidance games,
small modules with detailed block comments explaining *why* (the existing docstrings in
`tournaments.ts`, `game.ts`, and `model.ts` set the tone). Commit messages: concise,
imperative subject line ("Add per-player stats page …").

## Keeping this guide up to date

This file only pays for itself if it stays accurate:

- **Update it in the same PR** as any change to commands/scripts, environment variables,
  project structure, architecture, invariants, or CI — a stale map is worse than no map.
- **If you find an inaccuracy while working on something else, fixing it is in scope** for
  your change. AI agents especially: correct it rather than working around it.
- Keep it terse and factual. Don't duplicate the README (features, deployment, licenses live
  there) — link instead.
- The `.claude/CLAUDE.md` symlink must keep pointing here; if this file moves, update the
  symlink and the README link.
