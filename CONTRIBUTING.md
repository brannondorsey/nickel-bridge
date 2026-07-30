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
                config.ts (the ONE parse of BASE_URL — PUBLIC_ORIGIN/COOKIES_SECURE,
                plus the boot assertion index.ts calls; lenient at import so tests
                can import it, strict at boot, see its doc comment),
                auth.ts (Google OAuth + DEV_AUTH dev login), db.ts (schema DDL, WAL),
                game.ts (loadBoard/submitCall/submitPlay/advanceRobots/boardView),
                tournaments.ts (JIT placement, standings, recomputeElo), stats.ts,
                activity.ts (the TRAFFIC feed's flat, ungrouped events — see
                "The activity feed" below),
                ai-players.ts (benchmark AI personas — the "house" rows ranked in
                The Field, see "Benchmark AI players" below), bot-play.ts (the shared
                strategy-injected bot board-play loop used by the demo seeder AND the
                AI personas), demo.ts + scenarios.ts + demo-seed.ts (DEMO=1 demo mode,
                on PR previews + the permanent demo app — see "Demo mode" below),
                logging.ts (the request-log serializer: Fastify's default line plus
                Fly-Client-IP and user agent, so "who woke the machine" is answerable —
                see "Machine time is bought by the request" below),
                seo.ts (SITE_ROUTES: the one table of which URLs are public and which
                are indexed — robots.txt is derived from it, the sitemap is checked
                against it, and web imports it too; dependency-free on purpose, see
                "Discoverability" below)
web             main.tsx → App.tsx (router + MeContext auth + splash gating + TabBar),
                api.ts (typed API client), splash.ts (nb:lastVisit returning-visitor gate),
                theme.ts (nb:theme night-mode preference — see "Night mode" below),
                pages/ (Board.tsx is the gameplay UI; Settings.tsx is the settings gate,
                where night mode, claim fast-forward, ladder listing and sign-out live;
                the sparklines' LOOKBACK switch (nb:lookback) stays on the Stats page —
                see "The profile sparklines" below; Scenarios.tsx is the demo-mode gallery;
                Glossary.tsx is the glossary screen; Tour.tsx is the first-crossing
                onboarding tour; Activity.tsx is the TRAFFIC feed, with all of its
                clock-dependent grouping in the pure, unit-tested activityFeed.ts
                beside it — see "The activity feed" below),
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
                seo:start/seo:end markers, which the prerender replaces per page, plus
                the pre-paint night-mode script),
                scripts/prerender.mjs (a BUILD STEP, not an offline generator
                like tools/'s — `build` runs it after `vite build` to prerender the
                glossary into dist/glossary-static/ and the landing page into
                dist/home-static/, plus sitemap.xml built from exactly those pages
                and checked against server/src/seo.ts; it lives here rather
                than in tools/ because .dockerignore drops the root-level tools/ and
                scripts/, see "Discoverability" below),
                seo.test.ts (the drift guard between that table and App.tsx's
                isPublicPath — the only test that imports across the workspace
                boundary, and the reason App.tsx exports the gate),
                public/ (favicon.svg + og-image.png, the checked-in social share card),
                components/ds/ (design-system pieces, incl. SignInBar — the logged-out
                bottom bar standing in for the TabBar, and SignInActions — the ONE place
                that resolves which sign-in doors a deployment has) + components/game/
                (auction, bid box,
                fans, trick area, deal diagram, toll-receipt score breakdown,
                GlossaryProse.tsx — SuitText + tappable glossary terms,
                SpecimenField.tsx — the "one deal, three crossings" table the tour and
                the landing page share),
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
                cloudflare.mjs (the CDN edge config, DERIVED from server/src/seo.ts —
                --plan/--apply/--check/--snapshot/--purge[--since|--force]/--audit; the purge
                compares ORIGIN bytes before vs after a deploy and must never be rewritten to
                ask the edge, see "The edge" below),
                fly-uptime.mjs (machine time per day from Fly's Prometheus — the metric
                the edge work is judged by; read its header before trusting a number,
                that API punishes two obvious approaches), og-image.mjs (regenerates the
                checked-in social share card web/public/og-image.png — offline, no
                running instance needed)
e2e             smoke.spec.ts — Playwright smoke at phone viewport (390×844)
docs            design-brief.md — requirements spec for the visual redesign;
                rule-based-bidding.md — why robot bids are SAYC-guardrailed and the
                shelved full rule-engine design; difficulty-tuning-guide.md — how to reason
                about/measure/tune the difficulty dials in packages/ai/src/difficulty.ts;
                difficulty-calibration-research.md — the research log behind today's values;
                edge-runbook.md — the operator's companion to scripts/cloudflare.mjs: how to
                verify a fronted host end to end, and how to measure whether it bought
                machine time (see "The edge" below);
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
`.github/workflows/pr-preview-teardown.yml` — which cancels the in-flight CI run and then
watches until the app *stays* destroyed, because `deploy-preview` sits behind
`needs: [test, e2e, docker]` and would otherwise re-create the app minutes after teardown
had already run and found nothing; `deploy-preview` re-checks the PR state immediately
before creating anything for the same reason), and every push to `main` deploys to production
*and* redeploys the permanent demo app (`nickel-bridge-demo`, demo-bridge.brannon.online — a
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
| `BASE_URL` | `http://localhost:3000` | public origin, parsed **only** in `config.ts` (see below); feeds the OAuth redirect + secure-cookie flag (`auth.ts`) and `robots.txt`'s `Sitemap:` line (`seo.ts`, called from `app.ts`). Set but not an absolute http(s) URL ⇒ the server refuses to boot; unset ⇒ boots with a warning |
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

**Machine time is bought by the request**, so the request log records who is asking. With
`auto_stop_machines = 'suspend'` and `min_machines_running = 0`, *any* inbound request wakes
a dedicated `performance-1x` core and holds it for Fly's whole idle window (~6-8 min
observed) — so one bare `GET /` from a crawler costs the same as a real visit, and a low but
steady trickle of them keeps the machine up permanently. Fly's health checks are not part of
this: they reach the machine directly from flyd rather than through the proxy, so they can
neither wake it nor keep it awake. `server/src/logging.ts` therefore logs `clientIp`
(`Fly-Client-IP`, falling back to `X-Forwarded-For`) and `userAgent` alongside Fastify's
default fields; `remoteAddress` deliberately still means the proxy. A line with no `clientIp`
came from flyd, not the internet. Note the SPA fallback above returns **200** for every
unmatched path, so scanner probes do not show up as 404s — the user agent is the honest
signal, not the status code. This pulls directly against the discoverability work above,
which exists to get `/` and the glossary crawled: every one of those visits is a wake, and
they are the wakes we *want*. `robots.txt` is the lever for the rest — a route that isn't
prerendered has nothing to offer a crawler and should stay `Disallow`ed, which is why
`/leaderboard`, `/players/` and `/tour` are on that list despite reading without an
account. On the API side, `app.ts`'s interactive-request hook gates on `hasSession` rather
than the `/api/` prefix, so anonymous polling of the public reads can't also park the AI
personas' background play. Historical machine time comes from Fly's Prometheus
(`fly_instance_up`, scraped every 15s; the metric is simply absent while suspended). Query it
with `Authorization: FlyV1 <token>` — not `Bearer` — and derive uptime from raw samples
rather than `count_over_time`, which gets downsampled over long ranges and badly under-reports.
Raw samples are age-dependent too (15s yesterday, 30s a few days back, 60s a week back, with
samples dropped rather than merely thinned), so **two days at different resolutions are not
comparable** and a before/after baseline has to be recorded while it is fresh.
`scripts/fly-uptime.mjs` does all of that and prints the resolution it inferred per row.

**The edge (Cloudflare) is derived from `seo.ts`, like everything else that answers "is this
URL crawlable?"** The measurement behind it: production ran 20.1 h/day and the demo app —
which has *no human users* — burned 1.8 h/day, and every crawler observed in a day of
instrumented logs (SemrushBot, YandexBot, ClaudeBot, AggregatoreBot, link-preview fetchers)
touched only `/robots.txt`, `/`, `/sitemap.xml` or `/og-image.png`. **`robots.txt` cannot fix
this and it is worth knowing why:** ClaudeBot fetched the demo app's robots.txt, read
`Disallow: /`, obeyed it, and left — and that one compliant request still cost seven minutes
of dedicated CPU, because a bot has to reach the origin to learn it is unwelcome. Disallowing
a crawler takes a visit from 127 requests to 1, never to 0. Only an edge that answers those
paths without touching Fly does that.

`scripts/cloudflare.mjs` builds the rules from `SITE_ROUTES`: **bypass** is every `spa: false`
row, **cached** is every `indexed: true` row plus the static files no router row covers. So
adding an indexed route starts caching it and adding an API route starts bypassing it, with no
edit here — the same reason robots.txt and the sitemap are derived. Its invariants run on
*every* invocation, including the `--plan` CI runs on each PR, and the load-bearing one is that
nothing session-scoped can reach the cache set: `boardView` redacts hidden hands per player, so
a cached `/api` response is one player's view of the deal served to another. That is an
information leak, not a stale page.

**Both hosts are fronted.** Demo went first and was verified end to end behind the proxy —
clean TLS, the crawler surface HITting, `/api/me` and `/demo` `DYNAMIC`, edge bytes identical
to origin, `--audit` green — and production followed. Adding production was literally
uncommenting its row in `SITES`, because rules, invariants, purge list and audit are all
derived per host.

What caching buys each is very different, and worth knowing before reading too much into demo.
Production takes ~1,364 requests/day across 13 PoPs, so repeat traffic per (PoP, purge-window)
is high and the cache pays off. Demo takes ~43/day across 4 dominant PoPs and redeploys ~3×/day
— and each deploy purges — so most crawl sessions are the first at their PoP since the last
purge and MISS anyway, earning perhaps 10-20% there. **Demo is the debugging surface;
production is where the machine time is.** It follows that the binding constraint is purge
frequency against crawl frequency, not the TTL, which is why `--purge` compares before dropping.

**Deploying a phase entrypoint is a PUT — it replaces that phase's whole ruleset, zone-wide.**
On a shared zone that is destructive with no undo, so every managed rule carries a
`[nickel-bridge]` prefix and `--apply` preflights *both* phases and refuses to write either if
it finds a rule without it, naming what it would have deleted. Adding a Cache or Configuration
Rule for one of the zone's other hostnames by hand will therefore stop the deploy rather than
be silently reconciled away — move it into this script, or keep it out of these two phases.

**Nothing here writes a zone-wide setting**, and that is deliberate: `brannon.online` is a
shared zone carrying ten other proxied hostnames on origins this repo knows nothing about, so
PATCHing `/settings/ssl` to reconcile one app would reach every one of them — and moving an
HTTP-only origin to Full (strict) takes it down. The SSL mode demo genuinely needs (Flexible
against `fly.toml`'s `force_https = true` is an infinite redirect loop) is set per-request by
a **Configuration Rule** instead, `set_config` in the `http_config_settings` phase, which the
Free plan allows. The zone default is read and reported, never written. `always_use_https` is
deliberately unmanaged for the same reason — zone-only, no per-host equivalent, and worth one
saved redirect at most; a scoped Redirect Rule is the way if it is ever wanted.

**`--purge` only drops what actually changed, and it asks the ORIGIN, never the edge.** Most
deploys touch no web output, so the built `index.html`, the prerendered pages and the generated
`robots.txt` come out byte-identical — and purging them throws away a warm cache for nothing.
That matters because a cold fill costs a full idle window *per PoP*, and with ~13 PoPs and ~3
deploys/day it is the purge rate, not the TTL, that bounds the hit rate.

So `deploy-*` runs `--snapshot --out=…` **before** `flyctl deploy`, recording what
`<app>.fly.dev` serves for a small sample, and `--purge --since=…` after it re-reads the same
sample and purges what moved. `robots.txt` is why the comparison runs against a live origin
rather than `web/dist`: it is generated at runtime from `seo.ts`, so no build artifact exists to
diff — and the deploy jobs never run `npm run build` anyway.

**Do not "simplify" this into asking the edge what it is serving.** That was the original
implementation and it was wrong in the direction that silently breaks pages: Cloudflare's cache
is per-PoP, and a plain `fetch` reaches exactly one PoP, whichever is nearest the runner. A URL
cold *there* misses, fills from origin, compares byte-identical, and is skipped — while every
other PoP keeps the previous build for up to the full 30-day TTL. The comparison also warms the
runner's PoP, so the one vantage point it can see is the one it just repaired. On the
2026-07-30 deploy of #111, which moved the bundle hash and therefore all 132 URLs, it reported
`1/132 urls differ` and purged one; IAD went on serving `/glossary` at age 12 h referencing
`/assets/index-3uRpM-0Y.js`, a filename that at origin returns the SPA fallback as `text/html`.
The origin has the property the edge lacks — one machine, same bytes for every caller.

Sampling ~8 URLs answers for all 132 because the prerendered pages are not independent: each is
a copy of the same built `index.html` with its head span and `#root` swapped, so all of them
embed that build's content-hashed `/assets/index-<hash>.js` and move together. `/` alone would
do; `/glossary` and two term pages are belt-and-braces for a `seo.ts` metadata change, which the
prerender reads but the bundle does not. Any HTML sample moving purges the whole HTML set; the
four static files purge individually.

Both halves are collected independently: an HTML sample moving expands to the whole HTML set,
a static file moving purges just itself, and a deploy that does both purges both. That is not a
hypothetical pairing — editing `seo.ts`'s route flags is the documented way to add an indexable
route, and it changes the prerendered pages and the runtime-generated `robots.txt` in the same
deploy. `server/test/cloudflare-purge.test.ts` pins it, along with every give-up case.

Every unknown resolves to **purge everything**: a missing or unreadable snapshot, a snapshot
whose sample set no longer matches (terms.ts changed shape), or a non-200 on either side.
Purging something unchanged costs one cold fill; skipping something that *did* change serves a
page referencing deleted asset hashes for up to 30 days. `--purge --force` skips the comparison
entirely, and a deploy that changed nothing never calls the Cloudflare API at all.

The one thing the per-deploy purge **cannot** do is repair staleness left by an earlier missed
or failed purge — it only knows about its own deploy. `edge-upkeep.yml` runs `--purge --force`
weekly for that, which is also what recovers the damage the edge-sampling version already did.

Exactly one job may write the zone-wide ruleset, and `deploy-production` is it: it runs
`--apply` (as `continue-on-error`, then fails the job in a later step) plus
`--purge --host=bridge.brannon.online`, while `deploy-demo` runs only
`--purge --host=demo-bridge.brannon.online`. The purge is a *separate step* from `--apply` on
purpose — a refused apply means the zone holds a rule this script does not own, which needs a
human, and is no reason to also strand the HTML this deploy just changed behind a 30-day edge
TTL. `--host` scoping matters because the two apps deploy independently and purging the other's
pages would discard good cache entries.
`.github/workflows/edge-upkeep.yml` runs `--check` (drift), `--audit` (cert + cache health,
per host) and a full `--purge --force` weekly — all three fold into the job's pass/fail, since a
repair pass that silently stopped running is the same as not having one. [docs/edge-runbook.md](docs/edge-runbook.md) is the operator's companion:
how to verify a fronted host end to end, and how to measure whether the fronting actually
bought machine time. Everything no-ops without `CLOUDFLARE_API_TOKEN`, so none of it activates
until that secret exists.

**A fronted host must be one label below the apex.** Free Universal SSL is issued for
`brannon.online` and `*.brannon.online`, and a wildcard matches one label — so
`demo.bridge.brannon.online` had no edge certificate, and proxying it failed the TLS handshake
and took the demo site down before a single rule was consulted. That is why demo lives at
`demo-bridge.brannon.online`. `SITES` asserts the depth, so `--plan` fails in CI rather than at
the moment someone flips the cloud; deeper names need Advanced Certificate Manager or Total TLS,
both paid and both dearer than the machine time saved.

Two things about proxying a Fly app that fail silently and late, both per
[Fly's Cloudflare guide](https://fly.io/docs/networking/understanding-cloudflare/). Fly
validates custom-domain certs over **TLS-ALPN**, and Cloudflare terminates TLS, so going
orange breaks renewal with no symptom until the current cert expires. The fix is
`fly certs setup <host>` plus the **`_fly-ownership` TXT** record, after which Let's Encrypt
validates over **HTTP-01 through the proxy** — specifically *not* DNS-01, whose
`_acme-challenge` records collide with the hidden ones Cloudflare's Universal SSL inserts.
`--audit` therefore checks the outcome (days to expiry, `validationErrors`) plus the one
combination that is definitely broken: proxied with TLS-ALPN as the only configured method.
And SSL mode must be **Full (strict)**: Flexible against `fly.toml`'s `force_https = true` is
an infinite redirect loop. Note also that once proxied, `Fly-Client-IP` becomes Cloudflare's
edge address, which is why `logging.ts` prefers `CF-Connecting-IP`.

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

**Demo mode (`DEMO=1`, PR previews + the permanent demo app at demo-bridge.brannon.online):**
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
`/tour`.
One more group is client-only and unlike all the others: **SIGNED OUT** (`Scenarios.tsx`'s
`SIGNED_OUT`) really ends the Inspector session — `api.logout()`, then a hard
`location.assign`, so the app boots as a first-time visitor's browser would with no stale
`me` to flash the signed-in variant. It has to: the landing page's live links, the tour's
ending toll gate, the ladder's unlinked human rows and a refused profile are all decided by
whether `me.user` is genuinely null, and no overlay can fake that. The way back is `/demo`,
said once on the panel rather than in every row. **Shipping a new
hard-to-reach or delta-driven UI state ⇒ add or update an exhibit in `scenarios.ts`** (mine
the recipe with the tool, label it from the tester's point of view) — or, for a state that
needs no server board, a client-only row like those two groups. The drift-guard test
keeps existing exhibits honest, but only this rule keeps the gallery covering new features.

**The first crossing (onboarding):** a new account goes straight onto the tollkeeper's
practice board — nothing precedes it. It used to be a four-page pamphlet (cover, a
philosophy panel I · THE BRIDGE, duplicate as a specimen ledger II · THE LEDGER, then a
practice offer), and briefly a single welcome screen merged from the first and last of
those. Both were redundant by the time anyone read them: the landing page makes the
philosophy and duplicate arguments in its own sections I and II — word for word, down to
the headings and a shared `SpecimenField` — and its section V promises the practice board
in the same breath as the CTA that leads here. Nor is that a minority path; the gate fires
for a new account arriving at `/`, which is exactly where signing in from the landing page
returns them. Duplicate is argued only after the deal now, by the field reveal, with the
house personas' real results on the cards just played. **`COPY.skip` moved to the
tollkeeper's narration ribbon** — sticky, so unlike the pamphlet's fine print the way out
is reachable at every moment of the deal rather than only before it starts. `users.onboarded_at`
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
(the tollkeeper's ribbon, but not its display type) renders through
`GlossaryProse` under `script.ts`'s `TOUR_LINKS` policy, so the words a first-timer is
meeting for the first time open the term sheet — which means the gate-rendered tour needs
its own `GlossaryProvider` in `App.tsx`, since it renders in place of the routes the app-wide
one wraps (a sheet lives in `?term=`, leaving the path alone, so opening one never disturbs
the arrival gate).

**The profile sparklines are scrubbed, not tapped, which is what makes the LOOKBACK switch
possible.** `ds/Sparkline.tsx` used to give every point its own full-height invisible button
in a flex row; across a ~326px plot that is 326/n per target — fine at 10, tight at 25, an
untappable 3px at 100 — and it put one tab stop per point per chart in the keyboard order.
The plot is now a single `role="slider"`: pointer and arrow keys resolve the *nearest* point
by x, so there is no per-point DOM at all and no ceiling from the tap layer.
`aria-valuetext` carries the reading (name, date, value), which is why the visual detail line
below the plot is `aria-hidden` — otherwise every step announces twice. The polyline strings
are memoized on `points` so scrubbing repaints only the crosshair; if a series ever exceeds
the ~326 available pixel columns, decimating the *drawn* vertices (never what the scrubber
resolves against) is the next lever, and nothing does that today.

What's left bounding the window is legibility, not the DOM: past roughly 150 points the line
reads as texture, and the vertical scale spans a whole career so recent movement flattens. So
`DEFAULT_LOOKBACK` stays 25 and the reader opts into more via one switch above all three
charts (never one per panel — three charts that can disagree about their period is worse than
no control). `offeredWindows()` in `Player.tsx` only offers a window **strictly shorter** than
the history: a 25 button on a 25-tournament record redraws exactly what ALL draws, so the
switch stays hidden entirely until the 11th crossing and never shows a button that does
nothing. A stored preference the history has outgrown resolves to ALL rather than clamping.
None of this costs the server anything — see `DEFAULT_LOOKBACK`'s doc comment for why
`fieldPercentiles()` already pays for every tournament a profile could plot.

**Elo is recomputed from scratch** every time a board completes: `recomputeElo` wipes
`elo_history`, resets everyone to 1200, and replays all tournaments **in tournament-id
order** (not timestamps). That's deliberate — a late finisher in an old tournament re-ranks
everyone — so don't "optimize" it into an incremental update without redesigning the model.

**The activity feed ("TRAFFIC")** answers the one question the ladder and the profiles don't:
who else has been on the bridge lately. `GET /api/activity` (`server/src/activity.ts`) is a
seven-day, signed-in-only read — gated where `/leaderboard` is public, because a bounded list
of handles and ratings is a different thing from when real people sit down to play and for how
long. Humans only (`users.kind = 'human'`: the house personas play constantly and would drown
it) and standard tournaments only, so it carries both filters. Two facts drive its whole shape,
and neither is incidental:

- **The server is timezone-blind**, so it cannot do the grouping. The feed groups by calendar
  day and by morning/afternoon/evening in the *viewer's* clock, so `activity.ts` emits flat,
  ungrouped events at per-board grain and `web/src/pages/activityFeed.ts` buckets them in the
  browser — reusing `format.ts`'s `timeGreeting()` unchanged, so the feed and the Home greeting
  can never disagree about when evening starts. That is a deliberate divergence from
  `stats.ts`'s `dailyBoards`/`DayGrid`, which bucket UTC days server-side. The route fetches
  **eight** days for the seven it renders, so the oldest local day is never a stub clipped by
  the viewer's offset. The cost is stated rather than solved: a Tokyo player's midnight run
  lands in a European viewer's afternoon.
- **`elo_history` carries no timestamp** (see the section above — it's wiped and replayed in
  tournament-id order), so a rating event is stamped with the player's last completed board of
  that tournament, exactly as `stats.ts`'s `stmtEloSeries` already does. A delta therefore
  lands at the end of a crossing, and an old tournament finishing today can restate a number
  shown yesterday. That is disclosed in the screen's footer rather than engineered around;
  snapshotting deltas into their own table would fight the evergreen-Elo model. A crossing that
  rated nobody reports `eloDelta: null`, never `0` — the display collapses both to an em dash,
  matching the ladder's `Movement`, but the data keeps them apart.

Milestones (`first-crossing`, `entered-rankings`, `peak-rating`) derive from one player's own
history. "Passed X on the ladder" is deliberately absent: it needs the ladder's order
reconstructed at two points in time, and the same recompute that can restate a delta can
reorder the pair. `entered-rankings` takes the provisional quota as an **argument** rather than
reading `PROVISIONAL_MIN_TOURNAMENTS`, because `DEMO=1` relaxes it to
`DEMO_PROVISIONAL_MIN_TOURNAMENTS` and the seeder's bots never reach the production 4 —
hardcoding it made the milestone unreachable in exactly the environment built to click-test
it. `app.ts`'s `provisionalMin()` is the one place that env is read, shared with
`/api/leaderboard`; `activity.ts`, `stats.ts` and `tournaments.ts` touch no env at all. Note it
means **rated** tournaments, not played ones — a crossing only rates you when a second human
finishes the same field — so the milestone is named for the screen a player lands on rather
than for a number of games. One run can earn several milestones; `pickMilestone` ranks them by
weight (first crossing, then the rankings, then a peak) and takes the **highest** peak, since a
long sitting can set a new best repeatedly and the events arrive oldest-first. The one new
index in the schema, `idx_boards_updated`, exists for this query — every other board sweep
starts from a user or a tournament, not a time window.

A row's board count and its crossings deliberately don't reconcile — six boards with one
crossing finished means a tournament was left unfinished, one board with a crossing means it
was finished on that run's first board — and a clause accounting for the difference was tried
and cut. The line reports what someone did, not a balance sheet.

The day strip's mark heights are **logarithmic** (`MARK_FULL_BOARDS`, `activityFeed.ts`), which
is the only way to keep a four-board crossing clearly visible while a five-tournament sitting
still reads taller than a three-tournament one — a linear scale either flattens ordinary
evenings or pegs the ceiling by the third crossing. A mark is one *run*, not one crossing, so
five tournaments in a single evening is a single tall mark.

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
attribute set; the settings gate's Day/Night/Adaptive/System switch (`theme.ts`, `nb:theme`
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

**The settings gate** (`web/src/pages/Settings.tsx`, the sixth tab) is one perforated panel
of identical rows — tracked-caps label, the italic aside that says what the setting does,
then a full-width `.pref-switch` segmented lever. Four segments for appearance, two for a
switch: the SAME component at different arities, deliberately, which is why the design
system still has no on/off toggle. Night mode and sign-out moved here off the Stats page,
which is the ledger and now holds nothing that isn't a record of play.

**Where a preference lives is a decision, not an accident.** Both new rows are columns on
`users` (`fast_forward`, `ladder_listed`), written through one partial-update endpoint,
`POST /api/me/prefs` — a route per switch doesn't pay for itself when the list is plain
per-user booleans and still growing (`difficulty` is already a column waiting for a UI).
Absent keys are left alone; an unknown key or a non-boolean is a 400, so a typo can't look
like a successful write. Appearance is the ONE device-local row, and only because it has
to be applied before first paint by the inline script in `index.html` — no round trip can
answer in time, and `SYSTEM`/`ADAPT` are per-device ideas anyway. The footer says that
once rather than tagging rows. Each of the two new settings has one thing worth knowing:

- **Fast forward settled tricks** (`users.fast_forward`, default on) is a *pacing*
  preference and cannot be anything else. When `advanceRobots` resolves a claim it has already played every
  remaining card (`resolveClaim`, `game.ts`) — the response arrives with the board finished
  — so nobody chooses a card in that tail under either setting. `stageClaimSteps`
  (`playAnim.ts`) takes a `fast` boolean, not a bare speed multiplier, because the two modes
  use genuinely different gap sets rather than one scaled by the other: on replays at
  `CLAIM_GAP_MS`/`CLAIM_TRICK_GAP_MS` (compressed — a claim can span up to 13 tricks, and
  nobody wants to sit through that many at table speed) scaled further by
  `CLAIM_SPEEDUP_FACTOR`; off reuses `stagePlaySteps`' own ordinary-play gaps
  (`GLIDE_MS`/`ROBOT_GAP_MS`/`HOLD_MS`/`COLLECT_MS`/`STAMP_MS`), so it's genuinely table
  speed rather than merely the claim pacing with the extra multiplier removed — an earlier
  version conflated the two, so off still looked like a fast-forward. Under
  `prefers-reduced-motion` there is no replay to pace, so the setting is inert. `Board.tsx`
  reads it off `MeContext` (so does `Tour.tsx`, defaulting to on for the signed-out visitor
  walking the practice deal). Letting a player actually *play* the settled tail would mean
  not claiming for that user, which is a server change with a real fairness cost — see the
  note under invariant 1.
- **Name on the ladder** (`users.ladder_listed`, default on) governs whether `/api/leaderboard` includes this
  player for an **anonymous** caller. That is the whole of it because the ladder is the
  whole anonymous surface: profiles already refuse a signed-out caller for every human and
  the activity feed is gated. A signed-in caller always sees the full field — the people
  you are matchpointed against can see who is in it. Ranks come from array position
  (`Leaderboard.tsx`), so an omitted player leaves no gap; a signed-out visitor's #3 can
  differ from a signed-in one's, which beats a hole in the numbering advertising that
  somebody opted out.

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

**The unauthenticated experience.** For a long time a visitor saw exactly one screen: a
login splash carrying ~20 words of deliberately cryptic copy, then Google OAuth. That is
also all a crawler saw. Both problems have the same fix — let people in far enough to
decide — and the pieces only make sense together.

- **`isPublicPath` in `App.tsx`** is the list: `/`, `/tour`, `/leaderboard`,
  `/players/:id`, `/glossary`, `/glossary/:slug`. A signed-out visitor gets those routes
  rendered for real, with `ds/SignInBar` in the TabBar's slot on the content ones
  (`wantsSignInBar` excludes `/` and `/tour`, which carry their own ask). Anything else
  falls through to the landing page — a shared board link should invite, not 404. The
  invariant is no longer "nothing user-scoped": profiles ARE someone's data. It is that
  **nothing here writes, nothing is scoped to the VIEWER, and no live board state leaks.**
- **`pages/Login.tsx` is the landing page.** The `<Splash>` stays exactly as it was — the
  toll gate is the brand, and `.splash-auto`, the returning-visitor overlay, is the same
  component — and the pitch scrolls below it. Never add a rule to bare `.splash`;
  `.splash-auto` overrides only six properties, so everything else leaks into it. Landing
  rules hang off `.landing`. The page ends on the three doors that need no account, which
  is the only place they're advertised.
- **Navigating resets the scroll offset** (`App.tsx`). A router navigation swaps the DOM
  without touching the window, which nothing noticed while every signed-out screen was a
  single 100dvh splash: a document shorter than the offset clamps back to the top on its
  own. A landing page several screens tall doesn't, so the glossary's `PLAY THE TOLL`
  dropped a reader who had scrolled the term list *below* the hero — sign-in included —
  and read as a dead button. The reset skips POP (back/forward is the one case where the
  old offset is the right answer, and the browser restores it already) and anything that
  leaves the path alone, since a term sheet is a `?term=` push on the route you're
  already reading.
- **The tour is playable signed out.** `pages/Tour.tsx` replays a captured deal
  (`onboarding/board0.json`) through the real board UI, so it never needed a server board
  — only its two exits did. Signed out, skipping just leaves, and the postmark's
  `PLAY THE TOLL →` becomes the sign-in itself. `TermSheet` no longer hides a term's
  `action` link, since its one destination (`/tour`) is public now.
- **The tour survives sign-in.** OAuth returns to `/`, which is exactly where the
  first-crossing gate fires — so finishing the tour would be rewarded with the tour.
  `onboarding/tourDone.ts` (`nb:tourDone`, alongside `nb:lastVisit` and `nb:theme`) is the
  claim: stamped on the way out to the gate, traded by `App.tsx` for
  `POST /api/me/onboarded` once a session exists. Three details are load-bearing, not
  defensive — the read is **non-destructive** (StrictMode double-invokes the `useState`
  initializer), it's read at **mount into state** (an effect would flash the tour's
  board first), and the claim **expires** (~1h, or an abandoned OAuth silently skips
  onboarding for whoever signs in on that browser next). The suppression flag is
  write-once for the session and never flipped back: clearing it when the stamp lands
  would re-open the gate for the render or two before the refreshed `me` arrives.
- **The leaderboard is public**, resolved with `optionalUser` (`auth.ts`) rather than
  `requireUserWithHandle`. Its one viewer-dependent field, `yourRatedTournaments`, returns
  **`null`** and not `0` — the client prints a "x of N crossings so far" note off it, which
  would be a lie told to somebody with no record. Signed out, the ladder's rows don't link:
  every one would lead to the same sign-in wall (see the next point), and a page of those
  is a page of dead ends.
- **Profiles are public for the HOUSE only.** `GET /api/users/:id/stats` serves an
  anonymous caller when `users.kind = 'ai'` and refuses otherwise. The personas are
  synthetic — nobody's record, and the one populated profile a visitor can read before
  signing up — while a human's profile is handle, avatar, account age, a day-by-day
  activity heatmap, rivalries and every tournament played. Served anonymously that turns a
  sequential id walk into a roster dump, and this app has no rate limiting to slow one
  down. Two details are load-bearing: the 401 is **uniform** (an unknown id answers exactly
  like a real person's, so the walk can't even map which accounts exist), and the
  kind check runs through `profileKind()` **before** `playerStats()`, so a walk can't drive
  the full stats query pile for every id it tries. The personas are reachable at all
  because `/api/leaderboard` returns them in a `house` array beside the ladder — they never
  rate, so they can't be ranked on it. `Player.tsx` renders an explanation rather than
  "Player not found" for a refusal, since the uniform 401 means the client genuinely
  doesn't know which it was.
- **`app.ts`'s interactive-request hook gates on `hasSession`**, not the `/api/` prefix:
  without that, a scraper polling the public leaderboard would park the AI personas'
  background play indefinitely.
- **The escape hatch for the remaining exposure (handles + Elo on the public ladder) now
  exists: "Name on the ladder" on the settings gate** (`users.ladder_listed`, default on,
  see "The settings gate" above), which drops a player from `/api/leaderboard` for
  anonymous callers only. There is still no rate limiting anywhere in this codebase — a
  deliberate call, not an oversight, since what stays public is a single bounded list.

**Discoverability: what gets INDEXED is a separate decision.** The app is client-rendered,
so a crawler that doesn't run JS (Bing, DuckDuckGo, most social and LLM crawlers) sees an
empty `#root`. Only prerendered pages are worth indexing, and that decision is written
down once, in `SITE_ROUTES` in **`server/src/seo.ts`** — one row per URL space, with a
`public` column (readable signed out) and an `indexed` one (prerendered + in the sitemap).
Both machine-readable outputs are derived from it, so they cannot drift apart:
`robots.txt`'s `Disallow` list is every row with `indexed: false` (`robotsTxt()`, called
by `app.ts`), and `web/scripts/prerender.mjs` imports the same table to check the sitemap
it emits. See "keeping it that way" at the end of this section.

- **The glossary is prerendered**, and it's the app's best long-tail surface: ~125 curated
  terms, each a page someone might land on from "what is a squeeze in bridge".
  `web/scripts/prerender.mjs` runs after `vite build` and emits one static page per core
  term into `web/dist/glossary-static/`, each a copy of the built `index.html` with the
  `seo:start`/`seo:end` head span swapped and `#root` filled. The module script is copied
  through untouched, so a human following a search result still boots the ordinary SPA
  over it (React clears `#root` on mount — the markup is a fallback, never a second copy
  of the UI to maintain). `app.ts` serves those files ahead of the SPA fallback, by
  membership in a `Set` of emitted filenames rather than by joining the raw slug onto a
  path. Deep-reference entries deliberately get no page of their own: they're close
  paraphrases of Wikipedia's glossary, so indexable prose for them would be thin,
  duplicative content competing with the source we adapted.
- **The landing page is prerendered too**, into `web/dist/home-static/` — its OWN
  directory, because the `Set` above is built by listing `glossary-static/`, so a
  `home.html` in there would silently also answer to `/glossary/home`. `app.ts` owns
  `GET /` for it, which is why `fastifyStatic` is registered with **`index: false`**:
  `@fastify/static` registers a route for the prefix itself, not just `prefix + '*'`, so
  `app.get('/')` alongside the default is `FST_ERR_DUPLICATED_ROUTE` at boot — not a
  route-priority contest like `/glossary` wins against the wildcard.
- **`/leaderboard`, `/players/` and `/tour` are public but `Disallow`ed.** None is
  prerendered, so a crawler would get the SPA shell — an empty `#root` wearing the HOME
  page's title, description and OG tags — i.e. thin near-duplicates competing with `/`.
  `/players/` has a second reason: being able to look someone up is a different thing from
  being findable by name in a search engine. Prerender one of them and flipping its
  `indexed` flag takes it off the `Disallow` list and puts it in the sitemap at once.
- **Both glossary URL forms answer the same way.** `/glossary?term=<slug>` serves that
  term's page, not the ledger index — it's the glossary's live sheet mechanism and the URL
  the app leaves a reader on (`Glossary.tsx` normalizes the path form into it with a
  `replace`), so it's the form that actually gets shared. Without this the server
  disagreed with the client about what `?term=` meant, and a shared definition unfurled as
  the whole glossary. The term page's self-canonical then hands the link back to
  `/glossary/<slug>`, which stays the canonical form and the one in the sitemap. An
  unknown `?term=` is not an error (it falls back to the index, 200); an unknown *path*
  slug is, and answers `404` with the SPA shell — browsers render a 404 body, so the app
  still boots and shows its own not-in-the-ledger sheet, while ~780 guessable
  deep-reference slugs stop looking like real pages to a crawler.
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
126 pages of generic metadata. And the shell deliberately carries **no**
`<link rel="canonical">`: it's served for every unprerendered route, so a static canonical
would tell crawlers that every deep link "is really" the home page. Prerendered pages
carry their own correct self-canonical (safe there, since each answers for exactly one
URL); everything else self-canonicalizes by default.

**Keeping it that way.** The sitemap must list only URLs that are both public and
prerendered — a sitemap entry for a `Disallow`ed URL is a contradiction a crawler reports
back at you weeks later — and it is now built from the pages the prerender run actually
wrote, never a list kept beside them. Three checks hold the rest together, and each one
fails a build or a test rather than shipping a quiet lie:

- `web/scripts/prerender.mjs` throws if a page it emitted is `Disallow`ed, if a page
  matches no `indexed` row, or if an `indexed` row produced no page. So flipping a flag
  without prerendering (or prerendering without flipping) fails `npm run build`, CI, and
  the Docker image.
- `web/src/seo.test.ts` holds `SITE_ROUTES`' `public` column against `App.tsx`'s
  `isPublicPath` — the one link no derivation can check, since that gate is app behaviour
  rather than metadata. It also reads the `<Route path=…>` list out of `App.tsx` source,
  so **adding any route fails this test until the table has an answer for it**.
- `server/test/discoverability.test.ts` spells the expected `Disallow` paths out literally,
  as a second opinion on the derived list.

So: adding an indexable route means adding a row with `indexed: true` and prerendering it;
the sitemap and `robots.txt` follow on their own.

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
   reordering and the score is unchanged — before accepting a new fixture.
   **Claims are why "fast forward settled tricks" is a pacing setting and not a play one,
   and there is an open question underneath them.** The claim gate is a TRUE-DD judgment
   (`solveFutureTricks` sees all four hands and assumes best play by everyone) and
   `resolveClaim` then plays the tail true-DD "at every difficulty" — but at beginner and
   intermediate the robots would have played that tail through `chooseCardSampled`, i.e.
   fallibly. So a position is only "settled" against a perfect opponent, and claiming
   quietly upgrades the robots for the rest of the hand, deleting whatever the human would
   have gained from an endgame mistake; the tier calibration, measured over full play, never
   saw those tails. That is uniform today — everyone's boards claim — and it is exactly why
   a per-user "don't claim for me" toggle was NOT built: it would hand two players on the
   identical board different robots because of a checkbox, and feed that into matchpoints
   and Elo. Whether the gate itself should consult the tier is unresolved and worth
   measuring; changing it is a deliberate robot change under this invariant.
   The demo-mode
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
