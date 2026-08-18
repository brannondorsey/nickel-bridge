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
                saycViolation feeds the robot bidding guardrail), medals.ts (the loyalty
                rail's tier math — computeMedalProgress, pure function of two counts the
                server supplies — see "Medal progress" below), types.ts, barrel in index.ts
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
                play via vendor/bridge-dds WASM; solveVia/analysePlayVia/
                ddTableVia/dealerParVia share ONE runVia pool-vs-main-thread
                policy), play-mc.ts (sampled-DD card play
                for non-expert difficulty tiers: K seeded hidden-hand layouts
                constrained by the auction's SAYC `req`s + shown-out voids, solved
                per layout, aggregate scores summed per legal card
                (scoreCardsSampled — the per-card score map, split out for
                Analyze's findability verdict; test/play-mc-golden.test.ts pins
                the split byte-identical) — then, per
                PLAY_NOISE, either the flat argmax or a seeded weighted pick among
                the top playTopN cards by that same score), difficulty.ts (tier
                type + K/BID_NOISE/PLAY_NOISE constants), claim.ts (isOutcomeInvariant —
                the auto-claim gate's second condition: an exact, deterministic,
                node-budgeted search for "no legal card by ANY of the four seats can
                change the result". Pure and SYNCHRONOUS, no DDS and no model, unlike
                everything else here), dd-pool.ts/dd-worker.ts
                (lazy worker_threads DDS pool — one enqueue path serving solve/
                analysePlay/ddTable/dealerPar under shared priority+starvation+
                timeout rules; latency only, never outcomes), play-mc-forget.ts
                (EXPERIMENTAL,
                unshipped card-"forgetting" prototype — see its doc comment and
                docs/difficulty-calibration-research.md)
server          index.ts (entry) → app.ts (buildApp(): all routes, serves web/dist),
                config.ts (the ONE parse of BASE_URL — PUBLIC_ORIGIN/COOKIES_SECURE,
                plus the boot assertion index.ts calls; lenient at import so tests
                can import it, strict at boot, see its doc comment),
                auth.ts (Google OAuth + DEV_AUTH dev login), db.ts (schema DDL, WAL),
                game.ts (loadBoard/submitCall/submitPlay/advanceRobots/boardView),
                analyze.ts (the Analyze review's verdict pipeline — two engines,
                four stages, the board_analyses cache; see "Analyze" below),
                rehearsal.ts (createRehearsal/listRehearsals — "Play From Here,"
                branching a finished board's real play into a live, never-scored
                board of its own; see "Play From Here" below),
                tournaments.ts (JIT placement, standings, recomputeElo), stats.ts,
                compare.ts (the Compare screen's gate arithmetic — full-tilt
                constants, three error models, verdict classification; a pure
                function of two PlayerStats, see "Compare and the gate" below),
                activity.ts (the TRAFFIC feed's flat, ungrouped events — see
                "The activity feed" below),
                medals.ts (composes stats.ts's two cheap counts into core's
                computeMedalProgress for /api/me — see "Medal progress" below),
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
                "Discoverability" below),
                security.ts (the response security headers — CSP, anti-framing,
                nosniff, referrer + permissions policy, HSTS — with what each one
                is for written beside it; see "Security headers" below),
                handle.ts (handle validation + the uniqueness KEY, which folds
                case AND cross-script lookalikes — see its doc comments)
web             main.tsx → App.tsx (router + MeContext auth + splash gating + TabBar),
                api.ts (typed API client), analytics.ts (the Google Analytics tag +
                its SPA page-view hook — see "Analytics" below),
                pageTitle.ts (what the browser tab says, per route — see
                "Page titles" below),
                splash.ts (nb:lastVisit returning-visitor gate),
                theme.ts (nb:theme night-mode preference — see "Night mode" below),
                suitPalette.ts (nb:suitPalette colorblind suit-color preference — its own
                device-local axis, orthogonal to theme.ts — see "Night mode" below),
                pages/ (Board.tsx is the gameplay UI, exporting BiddingPhase/PlayPhase/
                Result for the tour and Analyze; Analyze.tsx is the post-board review —
                see "Analyze" below; Settings.tsx is the settings gate,
                where night mode, suit colors, claim fast-forward, ladder listing and
                sign-out live;
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
                the pre-paint night-mode, suit-palette and returning-player scripts —
                the last of which suppresses the prerendered fallback, see
                "Discoverability" below),
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
                pages/Compare.tsx (the Compare screen — draws the server's
                verdicts, re-derives no statistics),
                replay/ (useReplay.ts — the shared replay driver extracted from the
                tour: staged transitions, the claim beats, cut() for jumps; and
                replayViews.ts — synthetic per-ply BoardViews for the Analyze play lens),
                components/ds/ (design-system pieces, incl. BeamBar — the
                diverging centre-line bar with its dashed gates, PrefSwitch — the
                arity-agnostic segmented lever (lifted out of Settings.tsx when the
                Analyze lens switch needed it), and SignInBar — the logged-out
                bottom bar standing in for the TabBar, and SignInActions — the ONE place
                that resolves which sign-in doors a deployment has, and MedalBar/MedalGlyphs —
                the Home rail and the shared suit-glyph row, see "Medal progress" below)
                + components/game/
                (auction, bid box,
                fans, trick area, deal diagram, toll-receipt score breakdown,
                AdjustedReceipt.tsx — the never-tolled twin ScoreReceipt lends its
                ReceiptRow/caption to, see "Play From Here" below,
                GlossaryProse.tsx — SuitText + tappable glossary terms,
                SpecimenField.tsx — the "one deal, three crossings" table the tour and
                the landing page share),
                src/test/ (fixtures + apiMock pattern),
                style.css (all styling — token blocks ported from the design prototype;
                [data-theme="night"] + its @media (prefers-color-scheme: dark) twin hold
                the night token overrides; [data-suit-palette="colorblind"] + its
                [data-theme="night"] and @media twins hold the colorblind suit-color
                overrides — see "Night mode" below; and "the responsive ladder", the ONE
                place the tablet/desktop breakpoints and the shell's own width live —
                see "One sheet, three widths" below)
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
                docs/difficulty-tuning-guide.md for how these fit together;
                calibrate_placement.mjs replays real placement demand through candidate
                PLACEMENT policies (its `current` baseline calls the real chooseTournament
                out of server/dist, so it can't drift from production) — the trace it eats
                is captured by the player-outreach skill, see "Tuning placement" below;
                calibrate_moment_floor.mjs sweeps candidate MOMENT_FLOOR values (Analyze's
                moments-ledger gate, server/src/analyze.ts) against a production trace of
                finished boards, reimplementing computeCore's stage-1+3 loop without the
                floor gate so every real DD-loss candidate gets one genuine stage-3 verdict
                to threshold post-hoc — the trace is captured by the player-outreach skill's
                analyze_trace.mjs, see "Tuning Analyze's moment floor" below
scripts         e2e.mjs (full two-user tournament against a running instance), ui-check.mjs
                (design-review sweep of every screen → docs/images-redesign/),
                responsive-check.mjs (the same walk shot at all four ladder viewports,
                `<name>@<width>.png` — the review artifact for any breakpoint change,
                see "One sheet, three widths" below),
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
docs            analyze-design.md — the Analyze design record, with its concept-exploration
                board analyze-concepts.html (three directions; the owner chose B,
                "The Second Crossing") and the round-four par-panel board
                analyze-cards-worth.html (four treatments; the owner chose D,
                "The Receipt and the Rail");
                compare.md — why most Compare rows refuse to name a winner: the
                three error models, the Agresti-Coull requirement, and the
                production measurement behind FULL_TILT;
                design-brief.md — requirements spec for the visual redesign;
                rule-based-bidding.md — why robot bids are SAYC-guardrailed and the
                shelved full rule-engine design; difficulty-tuning-guide.md — how to reason
                about/measure/tune the difficulty dials in packages/ai/src/difficulty.ts;
                difficulty-calibration-research.md — the research log behind today's values;
                auto-claim-uncertainty-research.md — why the auto-claim gate stopped trusting
                a double-dummy laydown, with the measured effect and a Resolution section
                correcting two claims in its own earlier analysis;
                edge-runbook.md — the operator's companion to scripts/cloudflare.mjs: how to
                verify a fronted host end to end, and how to measure whether it bought
                machine time (see "The edge" below);
                trump-placement-concepts.html — the concept-exploration board for the
                "trump suit to the left of the fan" request: three live, replayable
                motions over the real fan geometry, plus the re-sort rule and which
                hands it touches. The owner chose III, "The Draw" — shipped as
                web/src/components/game/trumpDraw.ts behind "Trump placement";
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
                roster and drafts the weekly player emails — see "Player outreach" below;
                skills/own-the-fix/, the workflow skill that carries a described
                change through PR, review and CI to merge-ready — see "Owning a change
                end to end" below; and four third-party skills installed individually via
                `npx skills add` rather than as marketplace plugins — skills/find-skills
                (vercel-labs/skills) discovers and installs further skills on request;
                skills/grill-me + skills/grilling (mattpocock/skills) are the relentless
                design-interview skill and the flow it delegates to (grill-me is a thin
                `disable-model-invocation` pointer — "call the Skill tool with 'grilling'"
                — so the two are always installed together); skills/responsive-design
                (wshobson/agents) covers container queries, fluid typography and
                mobile-first breakpoint strategy. Each is a symlink into
                ../.agents/skills/, the CLI's own canonical, cross-agent storage location,
                tracked alongside ../skills-lock.json. This per-skill install is the
                deliberate replacement for `.claude/settings.json`'s short-lived
                `extraKnownMarketplaces`/`enabledPlugins` blocks (PRs #186/#187): those
                registered two whole marketplace plugins — `ui-design` (~dozens of UI/mobile
                skills) and `mattpocock-skills` (~20 engineering-workflow skills) — for the
                sake of one skill each, and only take effect for a human running Claude
                Code locally who accepts the marketplace-trust prompt. A remote/web session
                never sees a project's `enabledPlugins` at all, so grill-me and
                responsive-design were unreachable from exactly the sessions meant to use
                them. The individual-skill install has no such gap: it's just files under
                version control, loaded by Claude Code's native skill reader everywhere
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
*and*, while enabled, redeploys the permanent demo app (`nickel-bridge-demo`,
demo-bridge.brannon.online — a stable DEMO=1 instance for automation and click-testing) — see
README.md "Deployment" for the one-time Fly setup and how preview auth (`DEV_AUTH`) works.
**`deploy-demo` is gated behind a literal `false &&` on its own `if:`** (flip it to `true` to
re-enable): it sees no real users day to day, so its whole cost is idle Fly machine/volume time
— measured at ~$1.50-2/mo via `node scripts/fly-uptime.mjs nickel-bridge-demo --recent`, which
is real but small money for something that mostly proves its own uptime. Disabling it stopped
short of deleting the Fly app: only its machine and 1GB volume were torn down (`flyctl machine
destroy` / `flyctl volumes destroy`), leaving the app shell, hostname, TLS cert and Cloudflare
edge config (see "The edge" below) untouched, so re-enabling is exactly the one-line flag flip
— the job's own "Ensure demo app + volume exist" step already recreates the volume and machine
from scratch on the next push to main, since it was self-provisioning/idempotent before this
flag existed. Separately,
`.github/workflows/claude-pr-review.yml` runs Claude (via `anthropics/claude-code-action`) on
every newly opened PR and posts a non-blocking review comment — authenticated via the
`CLAUDE_CODE_OAUTH_TOKEN` repo secret (a `claude setup-token` OAuth token billed against a
Claude subscription, not per-token API pricing), so it's independent of the checks above and
doesn't gate merges. One convention in those workflows: **the four jobs that hold
`FLY_API_TOKEN`** (the three deploys plus `pr-preview-teardown.yml`) **pin
`superfly/flyctl-actions` to a commit SHA**, because a branch ref re-resolves on every run and
that token can deploy arbitrary images, read the SQLite volume or destroy the app. Everything
else stays on its major tag; the pin has no automated watcher, so bumping it — and the other
actions' major tags — on a new upstream release is a manual, occasional chore:

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
robot actions, the client doesn't apply it in one jump: `web/src/components/game/playAnim.ts`
stages the transition into timed snapshots that `Board.tsx` applies on timers. In the play
phase that's `stagePlaySteps` (card-by-card glides, trick collect, tally stamp), animated by
`TrickArea.tsx`; in the auction it's `stageBidSteps`, which reveals the robots' calls one at a
time on `BID_GAP_MS` — the human's own call lands instantly, since waiting to see your own tap
register reads as lag rather than deliberation. `BID_GAP_MS` is reading time, not a gap after
an animation — a call is a sentence to digest rather than a card to watch land — and it has
been tried at 420 (too quick) and 840 (a noticeable wait across three replies) before settling
on 710, which is what a robot CARD costs, so the auction and the play read at one tempo. It is
deliberately its own literal rather than `GLIDE_MS + ROBOT_GAP_MS`: the two agree today but
measure different things, and retuning either shouldn't drag the other. `AUCTION_END_MS` *is*
derived from it, so the auction-ending beat can't silently stop being the heavier of the two.
That one needs no JS animation: each snapshot
holds `myTurn: false`, so the thinking notice renders for real rather than for zero frames,
and `AuctionGrid` marks the newest call `auction-latest` for a CSS drop-in. Note what those
snapshots deliberately do NOT blank, unlike their play-phase twin: `legalCalls` survives, so
`BidBox` stays docked and merely inert (its `waiting` prop) rather than being swapped for a
notice. The box sizes the dock and the decision cluster above hugs the dock's top edge, so
anything shorter there slides the hand and feedback down the screen and back on every turn —
and keeping it mounted is also what leaves its fold state to the lapse rule that owns it.
`stageBidSteps` also owns the
hand-off into play when the auction ends (`AUCTION_END_MS`, then `stagePlaySteps`' own
opening-lead staging), so callers dispatch on `prev.state === 'bidding'` alone. Server data is
untouched throughout, so anything that changes what a response *contains* should keep both
staging functions in mind.

**The calls that were already on the tray get the same reveal.** A board's dealer is
`(boardNo - 1) % 4`, so on three boards in four the human isn't the dealer and the GET that
opens the board answers with one, two or three robot calls already made (`ensureAdvanced`
in `game.ts` runs `advanceRobots` up to the human's turn before the view is built). Those
used to arrive in a single `setBoard`, and only the LAST cell — the call immediately before
yours — wore the drop-in, because `AuctionGrid` restricts `auction-latest` to the newest
entry so a mid-play re-render can't cascade the whole tray in. So `stageOpeningBids`
(`playAnim.ts`, applied by `load()` rather than `applyBoard`) is `stageBidSteps` run from an
empty tray: every call before yours lands on its own `BID_GAP_MS` beat, under the same locked
dock, so the auction has one reveal mechanism rather than one for the calls you sat through
and another for the ones you walked in on. Two things it deliberately does. It only fires on
a board the human has **not called on** (`isHuman` on the auction is the test — nothing is
threaded down from `Board.tsx`), so a reload or a second device mid-auction doesn't restage
calls the player has already read. And its leading step is the board with an **empty** tray
at `delayBefore: 0`, because there's a loading spinner on screen until the first step lands
and the beat before the first call belongs to the deal, not to the spinner. Note the knock-on
for anything that drives the real UI: for up to ~2.8s after a board opens, the bid box is
docked but every control in it is disabled, so `e2e/smoke.spec.ts`, `scripts/ui-check.mjs`
and `scripts/readme-shots.mjs` all wait on an **enabled** call button rather than on
`.bidbox`.

That empty leading tray is deliberately not zero-height, either: `AuctionGrid`'s row packing
(N/E/S/W, front-padded to the dealer's column) is driven by `reserveThrough`
(`Board.tsx`'s `auctionReserve`, set from `fresh.auction.length` right alongside the
`stageOpeningBids` call), not by `auction.length` alone — so the empty first frame already
renders however many rows the FULL pre-existing tray will need, blank, and each call fills a
cell rather than adding a row. Left at `auction.length` (the default, correct for ordinary
play, where the auction genuinely growing turn by turn is the point), the table would gain a
row partway through the reveal — e.g. West opening the auction lands a call in the tray's
already-reserved first row, but North's reply would otherwise wrap into a brand-new one — and
because the decision cluster below hugs the dock's top edge (`margin-top: auto`), that row
appearing mid-reveal slides the hand and feedback down the screen and back before the player
has even acted, the same layout-shift `waiting` exists to prevent for the bid box itself.

**The human's own card does not wait for that round trip.** `submitCard` used to await
`POST /play` before rendering anything, so the whole request — p50 64ms / p90 173ms measured
against production hardware, and worse on a woken machine — was dead time with the tapped card
still sitting in the fan. Nothing in the response is needed to draw it: `legalCards` came from
the server, so legality is already settled, and `advanceRobots` can't change where the human's
own card lands. So `optimisticPlayView` (`playAnim.ts`) predicts **that one card and nothing
else** — into the trick, out of whichever fan it came from, turn to the next seat — and
`Board.tsx` shows it on the tap. Counts, trick boundaries and dummy exposure stay the server's
to report; the function returns `null` for anything less than certain (not your turn, a card
the server didn't list, a full trick, and the opening lead, which is the one card whose staged
step also tables dummy), and the old await-then-render path runs unchanged.
The steps are still computed from the PRE-TAP view, so `stagePlaySteps` produces byte-identically
what it always did; `trimStagedPrefix` then drops the one step already on screen and subtracts
the time it has been up from the next step's delay. That subtraction is the part worth
understanding: the response now lands *inside* the `GLIDE_MS + ROBOT_GAP_MS` (710ms) beat the
animation was always going to spend between the human's card and the robot's reply, so the
round trip costs nothing visible until it exceeds that — and when it does, the stall lands on
the robot's card, where a pause reads as thinking. Measured tap→card in Chromium at 6× CPU
throttle: p50 33-39ms / p90 649-750ms before (tracking the round trip exactly), p50 10-14ms /
p90 14-17ms after (flat, whatever the server does). Claims are deliberately left out of the
trim: `runClaim` owns that sequence and its announcement hold already separates the tap from
the fast-forward.

**A rejected play means this screen is BEHIND THE SERVER**, and that is the only thing it
means. Every rejection `submitPlay` can raise — `not in play phase`, `not your turn`,
`illegal card` — is thrown after `refresh()` re-reads the row under the board lock, so all
three say the same thing: another tab or device moved this board on. So the pre-tap position
is not something to hand back. Restoring it and leaving the fan tappable is the worst of the
options: the next tap is made against a trick that is no longer on the table, and if that card
happens to still be legal in the position the server actually holds, it simply plays — a card
chosen to follow a lead that isn't there any more. Replacing the screen with the "back to
lobby" `error` page is the other extreme, and throws away something recoverable: the board
isn't broken, its state is merely UNKNOWN, and one `GET` settles it.

So `submitCard`'s catch sets `playNotice`, puts the pre-tap position back **locked** (`myTurn`
false, no `legalCards`, exactly as a staged snapshot is locked) so nothing can be tapped
against a stale trick, and calls `resync()` — a plain refetch of this board that leaves the
notice up until the true position lands. Deliberately not `load()`, which would blank the
board to a spinner and reset the screen for what is usually one round trip. `error` still
means "there is no board" and still replaces the screen, and is still what a failed *resync*
sets. This also covers the failure the client cannot tell this apart from: `api.ts`'s
`request()` throws a bare `Error` with no status, so a dropped connection where the server
never saw the play looks identical, and there the refetch simply returns the same position.

**The notice owns that transition for `RESYNC_MIN_NOTICE_MS` (3s), and the new board lands
with it.** The refetch is one `GET` against a board the server already holds in memory, so it
usually answers in single-digit milliseconds — faster than the notice can be read, and often
faster than it can be SEEN. Without the floor the player gets an unexplained flicker and a
board that silently jumps to a different position, which is the one thing the notice exists to
prevent: the point is telling them their screen was behind *before* the screen changes under
them. Measured driving the demo exhibit in Chromium: 3004ms visible, with the position holding
still underneath for all of it. It is a floor rather than a delay — a slower refetch costs
nothing extra, and the board is locked either way, so it never keeps anyone from a move they
could have made. The failed-resync path is held the same way, or an instant `error` screen
would leave no trace that a resync was attempted at all.

`rejectStreakRef`/`RESYNC_ATTEMPT_LIMIT` bound it. The resync only settles anything if the
server eventually agrees with its own `GET`; a second device playing continuously could
otherwise ping-pong refuse → refetch → auto-play → refuse indefinitely, at two round trips a
lap. After the limit the screen stops trying and offers the player a reload. `playNotice` also
**parks the auto-play timer** (`AUTO_PLAY_DELAY_MS`) while a resync is in flight — a refused
forced play would otherwise re-fire it against the locked view.

Two things about testing this area, both learned the hard way. jsdom ships no WAAPI, so
`motionOK()` is false in every Board test by default and `stagePlaySteps`/`trimStagedPrefix`
are simply never reached — the whole trim path could be deleted with all of `web`'s tests
passing. Stubbing `Element.prototype.animate` turns the staged path on (TrickArea's
`glideIn`/`collectSweep` both bail on a zero-width rect, so nothing actually animates), which
is how `board.test.tsx` pins the pacing. And a staged step's `setBoard` fires from a bare
`setTimeout`, outside `act()`, so React has committed nothing when `advanceTimersByTimeAsync`
returns — a trailing zero-advance is needed before asserting, in both directions, since an
uncommitted render reads exactly like a card that hasn't landed yet.

**Auto-play and claims:** two QoL layers sit on top of the flow above, both client-driven so
the server stays a plain request/response API. When `boardView.legalCards` has exactly one
card, `Board.tsx` plays it automatically after a short delay (`AUTO_PLAY_DELAY_MS`) instead of
requiring a tap — it just simulates the second tap of the normal select-then-confirm flow.
Separately, `advanceRobots` (`server/src/game.ts`) runs a double-dummy solve
(`solveFutureTricks` in `packages/ai/src/play-ai.ts`) at every real decision point; when the
gate below is satisfied it marks the board `claimed` and plays out the rest via `chooseCard`
for both sides — a claim is just "the server fast-plays a predetermined tail," not a distinct
completion path, so scoring/`finishBoard`/Elo are untouched.

**The gate is two conditions, and which apply is a property of the tournament**
(`tournaments.claim_rule`, resolved by `claimRule()` in `tournaments.ts` — see db.ts's
migration comment). The first is double dummy's: either side is DD-confirmed to win 100% of
the remaining tricks. That was the whole gate until the pessimistic rule shipped, and it is
still the whole gate on `'optimistic'` tournaments — every tournament that existed when the
migration ran, kept that way because re-gating a board already played would change its replay
(invariant 1). It is a claim about a minimax *value*, though: true only while everybody keeps
playing correctly. Fast-forwarding on it means the server quietly making whatever decisions
remain, including the player's own — measured on the golden trace's `hunt-1` board 2, the old
gate claimed at **trick four** and banked two overtricks the player had not yet earned.

So `'pessimistic'` — the default for every tournament created from now on — adds a second
condition: the position must be **outcome-invariant**, i.e. no legal card, by any of the four
seats, at any point in any continuation, can change the result.
`isOutcomeInvariant` in `packages/ai/src/claim.ts` decides it — an exact, deterministic,
node-budgeted search, pure and synchronous, no DDS. It leans on the framing to keep the
question cheap: "side C takes every remaining trick, always" is the same as "side D never
wins one, ever", so the search fails at the first trick D steals and only exhausts the tree
to succeed. Note what "any of the four seats" costs — C's own partner is an adversary too, so
a laydown that needs the right cashing order, or where one C hand can win and then be stuck
on lead, no longer claims. Measured over 116 boards: claims still fire on 66% of them (vs 78%
before), averaging 3.0 tricks fast-forwarded instead of 5.7, at ~0.6 ms of search per board.
Running out of budget just means no claim, which is why the budget is a pacing knob and never
a scoring one: a settled position plays out to the same score either way.

That also closes invariant 1's old open question ("claiming quietly upgrades the robots")
for new tournaments, and not by either route that had been proposed. The tail is still
true-DD at every tier — but once invariance is proven, every possible tail scores the same,
so there is nothing left for a weaker robot to be fallible *about*.

The boundary is persisted as `boards.claimed_at_ply` (the plays-index of the first
server-played tail card; NULL = no claim, or a pre-migration board): `GameBoard.claimed` stays
transient per-request, but a finished board must be able to say at rest where its tail stopped
being the human's own play — Analyze must never grade past it. The client detects a claim from `boardView.claimed` + `playHistory` (no extra fields
needed to know which side or how many tricks — see `claimAnnouncement` in `playAnim.ts`).
`Board.tsx`'s `runClaim` plays that response back in **three beats**, and `planClaim` in
`playAnim.ts` is the one pure place that decides which cards belong to which:

1. **The lead.** Because the solve only runs at a decision point with more than one legal card,
   the trick already in progress when the client's last request went out can still finish for
   *either* side before the guaranteed run begins. `claimAnnouncement`'s backward walk finds
   that boundary and reports it as `priorTricks`; those tricks replay first, at ordinary table
   pace, exactly as they would have without a claim. This is not cosmetic sequencing — without
   it you tap the card that wins a trick and a modal says "E/W CLAIM" before your card has even
   glided in, which is the board contradicting itself. `CLAIM_LEAD_SETTLE_MS` then holds for the
   trick tally's stamp (TrickArea's own 500ms) so the trick you just won is read, not just
   technically painted.
2. **The announcement.** A modal `ClaimOverlay` holds the board for `CLAIM_ANNOUNCE_HOLD_MS` —
   tap, click, or Escape dismisses early. Nothing else is moving while it is up, which is the
   point; the old in-flow banner popped up alongside cards already in motion and was easy to
   miss. `claimInfo` is set only at this beat, since a non-null `claimInfo` blanks `PlayPhase`'s
   board hint for the whole sequence and the lead should read like any other robot burst.
3. **The fast-forward.** The rest plays out through a separate `stageClaimSteps` staging
   function (kept apart from `stagePlaySteps`, which assumes at most one trick boundary per
   response — a claim can span many), reusing the same glide-in/collect machinery
   `stagePlaySteps` uses for ordinary play but at `CLAIM_SPEEDUP_FACTOR` pacing (33% faster than
   the claim's already-compressed base gaps), before handing off to the normal completion view.

The lead and the hold both apply whether or not motion is on — with no animation to wait out
there is still a tally that just changed and a piece of news, and both deserve their beat before
the jump to the result. Only the fast-forward is animation. A tap during the lead deliberately
skips nothing: `claimSkipRef` is armed only while the overlay is up, there is no affordance
offering a skip before then, and skipping would jump the very trick the lead exists to show.

`stageClaimSteps`' optional `range` is how one response splits into those beats. It gates the
pushes only — the accumulators, the per-trick winner tally and `allPlays` still span the whole
burst, so every emitted view stays an absolute snapshot. Slicing `newTricks` up front instead
would make `handAt` think the tail's cards were already played, and the human's remaining cards
would vanish from their fan during the lead and reappear when the fast-forward started. Each
trick is tallied by its actual winner rather than assumed to belong to the claiming side.

See invariant 1 below — claims change what `advanceRobots` records for a human's untaken
decisions, so they interact directly with the robot-trace fixture.

**Robot difficulty (sampled-DD play):** difficulty is a **per-board** property — the
duplicate-fairness unit is the board, so every player on (tournament, board) faces the same
tier, resolved by `boardDifficulty()` in `tournaments.ts` from two tournament columns:
`difficulty` (the placement-tier label) and `board_difficulties` (JSON `Difficulty[4]`, NULL
= uniform at the label). `placeUser` stamps both from the creating user's preference
(`users.difficulty`, default `'intermediate'`, set via `POST /api/me/difficulty` — backend
only, no web UI yet); today's schedules are always uniform, so ramps/mixed schedules are a
data change. A third column, `claim_rule`, is resolved the same way (`claimRule()`, right
beside `boardDifficulty()`) and is likewise stamped at creation and immutable — but per
TOURNAMENT rather than per board, since it describes the server's own behaviour rather than
robot strength and so wants no schedule; see "Auto-play and claims" above. Placement only
matches users into tournaments of their preferred tier (resume
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
`courtesyGap` only stops a persona from STARTING a new decision during a quiet gap — its cap
(`COURTESY_CAP_MS`) deliberately lets one proceed anyway after a bounded wait even during
continuous human play, and once dispatched, DDS's synchronous WASM solve can't be preempted
mid-flight. On a single-vCPU deployment (Fly's `performance-1x` — every environment this app
runs on) the shared DD worker pool (`packages/ai/src/dd-pool.ts`) collapses to exactly one
worker, so a persona's in-flight decision (up to K solves) could fully serialize a concurrent
human card-play request behind it — measured as an occasional multi-second freeze on card play.
`dd-pool.ts`'s `solve()` takes a priority (`'interactive'` default, `'background'` for every
bot-driven call — personas here, plus demo seeding and demo exhibit replay, all routed through
`bot-play.ts`): an interactive request jumps the queue for the next free worker ahead of any
queued (not yet dispatched) background request. This can't shorten a solve already executing,
only the wait behind the REST of a persona's batch — see `dd-pool.ts`'s doc comment for the
measured effect. That preference is **bounded** (`STARVATION_PROMOTE_MS`), and the bound is
load-bearing rather than tidiness: unbounded, a queued background request under a sustained
interactive backlog starves past `SOLVE_TIMEOUT_MS` and rejects, and its caller's fallback is
the **main-thread** `solveRequest()` — a synchronous WASM solve with no timeout that blocks the
event loop for every concurrent request, i.e. a worse freeze than the one being fixed. A
background request that has waited the bound is promoted to interactive.
That main-thread fallback is now a genuine last resort rather than the first thing tried:
`play-ai.ts`'s private `runVia()` is the ONE policy that chooses pool-vs-main-thread for every
DD call in the app — `solveVia()` plus the Analyze-era `analysePlayVia`/`ddTableVia`/
`dealerParVia` are thin instances of it — and it reaches the main thread only when there is no
compiled worker at all (vitest on TS sources) or when a second pool has also failed. A pool
that died mid-decision — which rejects every outstanding solve at once, so
`chooseCardSampled`'s K layouts all land here together — is retried on the replacement
`getSharedDdPool()` mints, instead of becoming K sequential event-loop-blocking solves.
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

**Security headers are set once, in the app, for every response.** `server/src/security.ts`
holds the table — Content-Security-Policy, `X-Frame-Options`, `X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy`, and `Strict-Transport-Security` — with a paragraph
beside each saying what it is for, because a header nobody understands is a header the next
person deletes. `app.ts` applies them in one `onSend` hook registered **before any route**, so
the API, `/auth`, the prerendered pages, the SPA shell, the 404 handler and the error handler
are all covered; a header set per-route is a header the next route forgets. Three things about
it are decisions rather than defaults:

- **App-level, not an edge rule.** Production, the demo app and every PR preview run the same
  `buildApp()`, so this is true of all of them the moment it ships. A Cloudflare Response
  Header Transform Rule would have covered only the two fronted hosts, only after `--apply`
  ran, and only until someone replaced the ruleset — and a phase entrypoint deploy is a
  zone-wide PUT (see "The edge" above). Cloudflare passes origin response headers through
  untouched, so the fronted hosts serve exactly these. The one wrinkle is that a response
  already in the edge cache carries the headers it was filled with: a deploy that changes
  only headers changes no origin bytes, so `--purge`'s comparison correctly finds nothing to
  drop and cached HTML keeps the old set until its TTL, the next content change, or
  `edge-upkeep.yml`'s weekly `--purge --force`.
- **The CSP deliberately carries no resource allowlist.** It shipped once with the full
  thing — `default-src 'self'` plus per-type allowlists naming gtag.js, Google's avatar hosts
  and GA's collectors, with the shell's two pre-paint inline scripts admitted by SHA-256 hash
  — and that half was taken back out. An allowlist is a second, invisible copy of every
  external thing the app loads, enforced in the one place a developer never looks: a
  production browser. `npm run dev -w web` serves through Vite, which sends no such header,
  and jsdom ignores one, so adding a font host or an embedded widget would pass every check
  in this repo and fail silently for real visitors. What it bought was containment of an XSS
  this app has no known sink for (React escapes by default; no `dangerouslySetInnerHTML`
  anywhere in web/src). What remains is only the rules that forbid what the app never does —
  `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`, `form-action 'self'` —
  none of which can block a script, style, image, font or fetch, i.e. none of which can break
  a page by being out of date. `server/test/security.test.ts` asserts that limit rather than
  just the contents, so re-adding a `script-src` is a deliberate act with a red test attached.
  If it does come back: put it behind `Content-Security-Policy-Report-Only` with somewhere for
  the reports to land, and enforce only what has been observed to be quiet.
- **HSTS is conditional, has no `includeSubDomains`, and is deliberately not preloaded.** It is
  sent only when `COOKIES_SECURE` says this deployment's origin is https (config.ts's single
  `BASE_URL` parse) — it is the one header a browser *remembers*, and `http://localhost:3000` is
  an origin contributors share across projects. `includeSubDomains` is left off even though
  browsers scope it to the sending host (never to a sibling on the shared zone): nothing lives
  under either app's own name today, so it would be a no-op rather than a real decision — add it
  back if a genuine subdomain of one of these hosts ever exists. `preload` is absent because the
  preload list is keyed on the registrable domain, and submitting would commit `brannon.online`
  and the ten other hostnames on that shared zone to HTTPS-only with removal taking months.

Two smaller boundary guards live nearby and are easy to re-break. `app.ts`'s `boardNoParam`
screens `:no` with `Number.isInteger`, not just a range: `2.5` is between 1 and 4, and the GET
route creates the row before it deals, so a fraction used to persist junk rows past the
four-board cap (SQLite stores the REAL as-is — `INTEGER` is an affinity, not a constraint, on
a non-STRICT table) and then 500 on the malformed deal it derived. The `boards` DDL now also
refuses the storage class, though only on databases created from it. And `handle.ts`'s
uniqueness key folds cross-script lookalikes (Cyrillic `а`, Greek `Ο`, fullwidth and
mathematical letters) onto their Latin twin *for the key only*, so a handle nobody can
visually distinguish from another player's collides on the unique index instead of joining
them on the ladder. Its doc comment says what the curated map does not claim to catch.

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

**Page titles are per-route, and there are three copies of the home one.** `pageTitle.ts` is a
pure function from (pathname, `?term=`) to the tab title, applied by `App.tsx` on every
navigation; without it the SPA wore `index.html`'s site-wide title on every screen, so three
open tabs, the history and every bookmark all read the same. It uses the app's own vocabulary
(Rankings, Traffic, the first crossing) but never the tracked-caps *look* of those labels — a
tab has no typography, so caps there is just shouting, and the brand's period flavour stays
out of functional copy. Two things it has to track that aren't obvious: **the router's
trailing-slash normalization** (`/leaderboard/` renders the ladder, so it must not title the
tab "Refused at the gate" — and that title would also make the analytics hit read as a 404),
and **which paths actually have a `<Route>`** — `/players/` and `/t/17/nonsense` render the
not-found screen, so the patterns are anchored rather than prefix tests. The gate in `App.tsx`
is about what is ON SCREEN, not what the URL says: a signed-out visitor at a private URL and
an account without a handle both get a screen rendered *in place of* the routes, and keep the
home title. A page that knows more than the URL (a handle, a date) may refine
`document.title` itself, but **not from a mount effect** — React commits child effects before
the parent's, so this one would overwrite it on that same navigation; it has to happen on a
later render, once the data arrives. **`App.tsx` computes the title once and hands it to BOTH the tab and
`useAnalytics`** — not two derivations of one value. React runs effects in hook-registration
order and the analytics hook is registered first, so an ambient `document.title` read inside
`trackPageView` reports every view against the *previous* screen's title, one navigation
behind forever (and the first view of a deep-linked session against the shell's). Threading
the value removes the ordering dependency rather than relying on someone preserving it;
`analytics.test.ts` sets the tab to the wrong string and asserts the payload ignores it. **The constraint to respect: it must agree with
`web/scripts/prerender.mjs` byte for byte** — a shared `/glossary/<slug>` link is served a
static page whose `<title>` is already right and the SPA boots over it, so any difference
shows up as the tab rewriting itself a beat later. So it isn't matched by hand: the prerender
imports `pageTitle()` and titles all 127 pages with it, the same derive-don't-duplicate move
`seo.ts` makes for robots.txt and the sitemap. That import is why `pageTitle.ts` stays
Node-importable (no DOM, no React) and why it imports `./glossary/terms.ts` **with the
extension** — the prerender runs under bare Node, whose resolver won't guess it, which is what
`allowImportingTsExtensions` in `web/tsconfig.json` is for. The one copy that can't be derived
is `index.html`'s shell `<title>` (a raw HTML file has no module graph); `pageTitle.test.ts`
reads that file and asserts it. Note the join between the pure function and the app is what
`App.test.tsx` covers — the pure function and the analytics hook both pass on their own with
the wiring deleted entirely, which is exactly how a title feature ships doing nothing.

**Analytics is Google Analytics 4 (`web/src/analytics.ts`), and nothing else.** Page views go
to the GA property `G-ZTL1SZ7ZKZ`. Four things about it:

- **The stock `gtag('config', …)` snippet is wrong for this app** and was deliberately not used
  as-is. It sends one page view at config time, so a client-rendered SPA records every visit as
  a single hit on the entry URL and never sees the glossary terms read, the tour walked or the
  boards played after it. The config here sets `send_page_view: false`, and `useAnalytics`
  (called from `App.tsx`) sends every view itself — including the first — off router state.
  Enhanced measurement (outbound clicks, scroll depth) is configured in the GA property, not
  here; unlike Matomo's link tracking it needs no re-arming per navigation.
- **It is off on throwaway deployments**, gated on `/api/me`'s `demo`/`devAuth` — the same
  signal `seo.ts`'s `throwaway` uses to shut crawlers out of the demo app and PR previews,
  whose traffic is bots, seeders and click-testing. That's a round trip rather than a hostname
  check on purpose: the production origin stays out of the bundle, and `App.tsx` already awaits
  `/api/me` before rendering. `gtag.js` is loaded lazily on the first tracked view, so a
  preview never requests it at all. Local development is excluded by hostname on top of that.
  **The gate is `reportsAnalytics(me)`, and it fails CLOSED** — the one part of this worth
  reading twice. `null` is not "a deployment with no flags set": `api.me()` throws on any
  non-2xx and `refresh()`'s `.finally` flips `loaded` regardless, so a cold-start 5xx while the
  Fly machine wakes leaves `me` null with the app rendering. Testing the flags on that gives
  `!undefined && !undefined` — true — which would report a preview into the production
  property, and the measurement id is hardcoded. An unknown deployment therefore reports
  nothing.
- **The tracked URL is path plus `?term=` and nothing else.** The term sheet is a search param
  on whatever route you're reading (`GlossaryContext`), so dropping the query would collapse
  ~125 term reads — the most useful thing here — into the page they were opened from. Every
  other param is discarded rather than enumerated. Path ids (`/t/17/b/3`) are left alone. Read
  the glossary's own numbers knowing that closing a sheet reports the page underneath again —
  ten terms opened off the index is eleven views of `/glossary` — since each is a real
  navigation and the dedupe is one slot deep, not a history.
- **Cookies are region-conditional, via Consent Mode defaults.** `analytics_storage` is denied
  across `CONSENT_REGIONS` (the EEA + the UK, where storing anything on a device needs opt-in
  consent this app has no UI to ask for) and granted everywhere else; ad storage is denied in
  every region, since the app runs no ads. Order is load-bearing — both defaults are queued
  **before** the config command, or gtag grants storage everywhere first and the denial arrives
  too late; a test pins that. **This puts two populations in one property**, which is the part
  worth knowing before reading a report: a granted visitor carries `_ga` and behaves like
  normal GA, while a denied visitor stores nothing, so their client id lasts one page load and
  a reload or a next-day return is a new "user". Users is inflated in the EEA/UK relative to
  elsewhere, and any retention or cohort figure mixing the two is a blend of two different
  measurements — segment by region or don't read it. The within-visit path (which pages, which
  glossary terms, in what order) is honest for everyone. Note what none of this settles:
  Consent Mode answers the storage/ePrivacy question, not whether sending a visitor's IP and
  user agent to a US analytics provider needs a lawful basis under GDPR.

None of this costs the Fly machine anything, and it's outside the Cloudflare rules below for
the same reason: `gtag.js` is served by googletagmanager.com and hits land on Google's
collectors, so no analytics request wakes or holds the app's dedicated core.

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

**The purge also runs when the `flyctl deploy` step itself FAILED**, for the same reason one
step further out, and it is worth knowing what taught us that. On 2026-08-08 a flyctl 408
mid-rolling-update failed `deploy-production` *after* the machine had already been replaced:
the origin served the new build, the purge step never ran, and the edge went on serving HTML
whose `/assets/index-<hash>.js` no longer existed at origin — a missing asset answers as the
SPA fallback with `Content-Type: text/html`, which a browser refuses to execute as a module, so
the front page could not boot at all. A broken production front door, held for up to the 30-day
TTL, from a job whose only real fault was reporting an outcome Fly got wrong.

The deploy's exit code was never the right guard, because the purge does not trust it anyway:
`--purge --since` compares what the ORIGIN served before against what it serves now, so a
deploy that died before changing any bytes finds nothing and purges nothing, while one that
died after changing them is repaired. The job still fails either way — a Fly deploy that 408s
wants a human — it just no longer takes the edge down with it. Two deliberate limits: the step
is gated on the *snapshot* having succeeded rather than merely on the token (without a snapshot
the give-up rule purges everything, right when a deploy really happened and wasteful when an
earlier step like the `DEV_AUTH`/`DEMO` refusal meant there was never a deploy at all), and it
uses `!cancelled()` rather than `always()` — GitHub documents that exact swap as the recommended
one, since a step that keeps running through cancellation can hang the job.

What `!cancelled()` leaves uncovered is **not symmetric between the two jobs**, which is worth
knowing before trusting it. `deploy-production` has no concurrency group, so it is never
superseded and a cancelled run means a human clicked cancel — genuinely rare. `deploy-demo` sets
`cancel-in-progress: true`, so a second push to main supersedes the first routinely, and that
run's purge is skipped. Usually harmless, since the superseding run deploys and purges right
behind it — but its `--since` compares against an origin the cancelled run may ALREADY have
updated, so a commit whose web output is byte-identical (a server-only change) purges nothing
while the edge still holds the build from before the cancelled one. That residue is a stale demo
page until `edge-upkeep.yml`'s weekly `--purge --force`, and demo is the surface that can afford
it. `--apply` deliberately does NOT get the same treatment: its
rules are derived from the repo checkout rather than from what the origin serves, so applying
them after a failed deploy would point the edge at routes that deploy never shipped.
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

**Analyze (the post-board review) is two engines, because double dummy alone would lie to a
beginner.** `server/src/analyze.ts` + `GET /api/tournaments/:id/boards/:no/analysis` (+`?par=1`)
serve verdicts for a FINISHED board — the client only draws them (the Compare precedent). Per
human card decision: **cost** is the DD trace (`AnalysePlayPBN`, one call for the whole play)
converted to matchpoints by SUBSTITUTING the counterfactual score into the real field rows
(`boardFieldRows` — never appending; matchpoint averages aren't order-preserving under
insertion), and **fault** is `scoreCardsSampled` from the player's own seat (k=`ANALYZE_K`,
seed `${seed}:analyze:${boardNo}:${ply}`) — high cost with no fault (the sampled engine
would ALSO have played the card, `deficit <= 0`) is DROPPED before the response is built,
not shown-but-forgiven: a card nobody could reasonably find from that seat isn't a moment
just because an omniscient trace prefers something else, and a well-played board comes back
with an empty ledger rather than a wall of "not your fault" stamps (`ANALYZE_VERSION` bumped
when this shipped, so every cached analysis recomputes). Stage order is load-bearing: the DD trace is the cheap filter, the
sampled verdict the expensive one, and it only runs on candidates over `MOMENT_FLOOR`; par +
counterfactual auctions (`CalcDDTablePBN`, the slowest DDS call) run only when `?par=1` asks.
Computed on FIRST OPEN (never on completion), cached in `board_analyses` keyed by board id with
`version` = `ANALYZE_VERSION` and the par payload nullable; every solve dispatches
`priority: 'background'` — a live card-play solve beats a report loading, and
`STARVATION_PROMOTE_MS` bounds the wait. The cache stores ENGINE facts only: the
matchpoint layer (`refreshMatchpointLayer` — actualPct, per-ply costs, bid mpGains) is
recomputed against the LIVE field on every serve, so the whole response shares one field
with the Result's own table and a refresh sees late finishers; stage 3's floor selection —
which plies bought the expensive sampled verdict — is decided at compute time too, but a
field that grows afterward doesn't leave a ply stuck below a floor it has since cleared:
`getBoardAnalysis` calls `backfillDriftedPlies` right after the refresh, on every serve,
giving any newly-over-the-floor ply its one stage-3 solve there and persisting the result
(`sampleFindability`, extracted so `computeCore`'s first pass and this second chance can
never judge a card two different ways) — so a moment that was invisible on first open can
still surface on a later one without ever being recomputed twice.

**A bid moment must never fire when the "better" call would have reached the exact same
final contract you actually played.** `ddTableTricks` is a pure double-dummy fact about the
deal, indexed only by (strain, declarer) — identical regardless of which auction route
reached it (verified: it equals `analysePlayTricks`'s own ply-0 value for the same
contract). So when `computePar`'s counterfactual auction lands on a contract equal to
`core.contract` (same strain/declarer/level/doubled/redoubled, `contractsEqual`), the
"gain" it would report is entirely a PLAY-quality gap — DD-optimal play of that contract vs.
your actual play of it — with nothing a different bid could have changed; attributing that
gap to the bid was a false accusation, not a finding. `computePar` now leaves `cf` null in
that case, same as when the robot's own preferred call was the one played. This bumped
`ANALYZE_VERSION` (6): a cached analysis computed before it shipped could carry a
same-contract bid moment that should never have existed.

The served `momentFloor`
still backs one honest caption for the residual case backfillDriftedPlies can't close (Analyze.tsx's
play-lens ribbon compares a ROUNDED figure for display; the raw, unrounded mpCost decides
backfill, so a candidate sitting exactly on the rounding boundary can still read as
"cleared" without having cleared the raw gate). The grading boundary is `boards.claimed_at_ply`
(re-derived by `deriveClaimBoundary` replaying the claim gate for pre-migration NULLs — under
the board's OWN tournament's `claim_rule`, which is a required argument precisely so a legacy
board can't be re-derived under today's gate): cards past it were played by
the server for both sides and are never graded. Note the pessimistic gate deliberately does
NOT bump `ANALYZE_VERSION`: a board's claim rule is immutable, and every cache row that
existed at migration time belongs to an `'optimistic'` tournament whose derivation is
byte-identical to before — so nothing cached became wrong, and a bump would buy a full
recompute of identical output. The precondition is that immutability; see the note beside
`ANALYZE_VERSION`. Only the human's own cards are graded
(`humanControls`, both flip orientations — robot partner North never), forced cards are
skipped, and a one-player field refuses costs (`singleField`) rather than inventing them.
**MP figures render only inside the Analyze screen** — the Result, Tournament ledger and live
board carry the entry action and nothing else. `docs/analyze-design.md` is the design record.
On the web side (`pages/Analyze.tsx`): TWO lenses on a `?lens=` search param (a reading
position, not a stored preference) via the ds `PrefSwitch` — THE OVERVIEW (default) and
THE PLAY; the original three-lens shape's `crossing`/`auction` param values map to the
overview so early shared links keep working. The overview LEADS with THE CARDS WERE
WORTH — "The Receipt and the Rail", proposal D of the panel's four-concept redesign
board (owner-chosen): par and your table as paired receipts (the par stub sealed/dashed,
its DDS "3D*-EW-1" contract string parsed into the app's own vocabulary by
`parContractLabel`), over the field as dots on one rail with par as the dashed gate.
The rail's geometry is the pure, unit-tested `pages/analyzeRail.ts` (the activityFeed.ts
precedent): positions are LINEAR in the score with an order-preserving minimum-gap
relaxation — measured against a symlog axis, which flattens exactly the ±420–660 game
clusters bridge fields produce — with ties merged into counted dots, label bands
alternated, and the gate left at par's un-relaxed position; a field past `MAX_RAIL_DOTS`
is SAMPLED (YOU + both extremes always, then the modes) with the omitted tables counted
under the rail, never silently dropped. The WHERE IT TURNED moments
ledger follows. The ledger is the overview's ONLY bidding surface: bid moments carry
their counterfactual auction in the aside and are static findings (no link — the auction
has no replay to open), while the call-by-call YOUR BIDDING recap stays on the Result
alone. MP figures are framed as OPPORTUNITY, owner decision: `+38 MP` in the
`--positive` ink (matchpoints that were there for the taking), never a red −penalty. The play lens is a full
replay over the real board components driven by `replay/useReplay.ts` (extracted verbatim
from the tour, which is now a second consumer): forward steps stage one card at a time
through `stagePlaySteps` (its ≤1-trick-boundary assumption is why), BACK A CARD and the
trick pips `cut()` with no animation, and the audit ribbon
(the tollkeeper ribbon's shape, unvoiced) narrates the view the replay is actually showing
— the tour's lagging-caption move, with its caption slot height RESERVED (the bid-box dock
rule: a shorter caption must not scoot the board). A moment jump (`?ply=`, the ledger, the
PREV/NEXT MOMENT pair) collapses to ONE step: it cuts to the decision and immediately
stages the played card's glide, so the card that was played (in the trick) and the
engine's pick (the live pre-confirmation `.selected` treatment in the fan, an underlined
rank in the suit-line rails) are on screen together — the pager anchors on the moment
being read, not the replay position, which sits one card past it. **A moment gets exactly
that ONE beat**: the ribbon reads the card just PLAYED and never the decision about to be
made, so the engine's pick lights up with the played card rather than a beat before it. It
used to get two — the original landing was the pending decision ("The turn is here: South
to play, and the engine … plays 5♣"), with NEXT CARD showing what happened; the collapse
above staged the played card immediately but left that caption in place, so the same
finding was narrated once either side of the glide and walking the play spent two presses
on one moment. The pct pair the pending caption carried ("worth 67% instead of 50%") moved
onto the surviving beat, since a `?ply=` deep link never passes the ledger row that also
says it. A moment on a trick's
LAST card lands on a synthetic held view (trick complete on the table, un-collected —
`momentLandingView`) so the take-up sweep can't carry the moment away; the centre rail is
always the seat ACROSS the fan (`playingSeat + 2`), dummy-tagged when it is the dummy, so
South-declared and flipped boards show every hand exactly once. Only JUDGED-AND-CHARGED
decisions (`sampled` non-null — which, since the server drops the excused case before this
ever arrives, now always means genuinely chargeable) are moments to the pager and the
collapse; the sub-floor stage-1 candidates stay in `plies` for the ribbon's honest "a trick
slipped, but the matchpoints barely noticed" annotation and are never charged or landed on.
The open-hand rails
wear the dummy rail's kerning (thin-space rank separation + `.dummy-rail-ranks`'s
letter-spacing), and a centred PLAYED rail under them accumulates every card off the
hands, its two wrapped lines reserved up front (the dock rule again). Reduced motion (or no WAAPI — jsdom) renders the lens as a static annotated
trick-by-trick list instead, a legitimate reading rather than a fallback. Every moment shown
is charged and keeps `StarGrade` (✗ at 0) — a costly-but-unfindable candidate never reaches
either lens; the server drops it before the response leaves `computeCore`, so there is
nothing here to excuse. Only THE PLAY skips `?par=1`. The demo
gallery's `analyze-play` exhibit (`scenarios.ts`, `results` category) is the click-test
path; `Result` in Board.tsx is exported with an `actions` slot (which is also what
dissolved the tour's class-for-class `TourResult` copy).

**Tuning Analyze's moment floor: measure it, the same way FULL_TILT was.** `MOMENT_FLOOR`
(the matchpoint-point gate stage 2 applies before a candidate earns the expensive stage-3
findability verdict — see `analyze.ts`'s doc comment above) shipped at 10 on a first-principles
guess ("fields are small — one place in a five-player field is 25 points — so 10 is roughly
half a place"). That guess was never checked against what fields actually look like.
`.claude/skills/player-outreach/scripts/analyze_trace.mjs` pulls a read-only, anonymized trace
of finished standard-tournament boards (no names/handles/user ids — a board's own deal, calls,
plays and its real field's scores, the same safety shape as `placement_trace.mjs`); `tools/
calibrate_moment_floor.mjs` replays `computeCore`'s stage-1+3 loop against it WITHOUT the floor
gate — every real double-dummy-loss candidate gets one genuine, expensive stage-3 verdict
regardless of size, so candidate floor values can be swept post-hoc over a single pass instead
of one production run per floor. Measured 2026-08-13, n=1237 human-owned finished boards: mean
field size was 6.7, not 5 — "one place" is closer to 15 points and "half a place" to 7-8. 733
boards had a genuine double-dummy loss; 280 of 1280 such candidates (21.9%) were excused by
stage 3 as unfindable from the seat, leaving 486 boards (39.3% of all 1237) with at least one
real, gradable fault — the ceiling no floor value can exceed, and a follow-up finer sweep found
it is FLAT from floor=2 through floor=5 (486 at each), only easing off at 6 (485), 7 (481), 8
(477, 98.1% of the ceiling), with the real cliff between 8 and 10 (433, 89.1%). So stage 3's
excusal was already doing the "don't nag on noise" work well inside that flat band, and there
was no coverage or meaningful compute reason to sit above it. `MOMENT_FLOOR` is now 5 — the
cleanest round number inside the flat 2-5 band; re-run both scripts and record a fresh date + n
if the population's field sizes or mistake rate drift.

**Play From Here lets a player take the cards from any point in a finished board's real
play and see a genuine outcome instead of Analyze's caption.** Two entry points, both on
the overview: a `PLAY FROM HERE →` action beside WHERE IT TURNED's existing `WATCH IT`
(re-deciding that exact flagged card; `MomentRow` split from one whole-row `<button>` into
a wrapper holding both, since two actions can't nest — the accessible name on `WATCH IT`
is unchanged, so existing `getByRole('button', {name: ...})` assertions kept passing), and
a standing action in THE PLAY lens's replay dock, usable at whatever ply the reader has
scrubbed to, disabled past `analysis.claimedAtPly` (a UX courtesy — the server enforces the
same boundary). Neither confirms first; both `POST .../rehearse {ply}` and navigate straight
into the result. Never scored (no Elo/matchpoints/leaderboard/stats), never re-Analyzable
(one level deep only — `GET .../analysis` 404s a rehearsal tournament).

A rehearsal is its own **single-board `tournaments.kind = 'rehearsal'` row**
(`server/src/rehearsal.ts`'s `createRehearsal`), the same move demo mode's `kind = 'exhibit'`
tournaments already make — every placement/lobby/Elo-replay/leaderboard/stats/activity-feed
query in this codebase is an ALLOWLIST on `kind = 'standard'`, so a new kind value is excluded
from all of them for free. `origin_tournament_id`/`origin_board_no`/`branch_ply` (new
`tournaments` columns, NULL on every other kind) record what it branched from. It reuses the
**origin's own seed** and **origin board's own `board_no`** — `dealBoard(seed, boardNo)`
depends on exactly that pair, so the deal comes out byte-identical for free, and
`mcDecisionSeed`/`bidDecisionSeed` depend only on `(seed, boardNo, decisionIndex)`, never
tournament id, so reusing the seed is desirable rather than a collision risk: redeciding
nothing differently reproduces the real game byte-for-byte, diverging still applies the same
seed to a genuinely different position. `claim_rule` is copied from the origin for the same
reason, and is the ONE column where taking the schema default would be a bug: a rehearsal of a
pre-migration board has to claim exactly where that board claimed, or replaying the origin's
own cards stops reproducing the origin. The board itself is **raw-seeded** — `calls`/
`bidEvals`/`contract` copied verbatim from the origin (the auction never branches) and
`plays` truncated to `plays.slice(0, branchPly)` — then handed to the ordinary
`advanceRobots`/`submitPlay`/`boardView` machinery completely unmodified (nothing in them
checks provenance, only the row's own columns), followed by one `ensureAdvanced()` call to
fast-forward any robot turn sitting right at the branch point. This is new territory for the
codebase (every other "synthesize a board" path — demo exhibits, the AI personas, the
onboarding capture — replays through real `submitCall`/`submitPlay` instead), but mechanically
safe by the same argument.

**The rehearsal screen reuses `Board.tsx`'s existing route and default component completely
unmodified in its state machine** — optimistic card play, staged robot bursts, claim
handling, resync-on-reject, auto-play all come for free, which is what makes "identical to
the ordinary live play screen" (the one hard requirement here) close to free too:
`PlayPhase`/`BiddingPhase` need zero changes. `boardView()` adds a `rehearsal` field
(`{originTournamentId, originBoardNo, branchPly}`) whenever `t.kind === 'rehearsal'`, which
`BoardHead` reads to relabel the header (`"REHEARSAL — Board N, from Trick M"` in the
tournament-name slot) and swap the vulnerability chip for an `END` link back to
`/t/:originTournamentId/b/:originBoardNo/analyze` — the only two things that differ during
play. Leaving mid-rehearsal loses nothing (it persists, resumable — reload survival, mid-play
or after finishing, is just the same plain `GET` re-fetch any live board already relies on),
which is why `END` asks no confirmation either. At `state === 'done'`, a rehearsal renders
`AdjustedReceipt` instead of `ScoreReceipt`/`Result` — never `Result`: `matchpoints()` returns
a placeholder `pct: 50` against a rehearsal's own field of exactly one (nobody else ever plays
it), which would be a meaningless number to show. `AdjustedReceipt` itemizes the rehearsal's
own score the same way `ScoreReceipt` does (its `ReceiptRow`/`caption` exported for reuse), no
postmark (this never counted), then compares against `board.originResult` — the origin
board's own already-computed result, sent inline on a finished rehearsal's `boardView` (one
extra `boardResult()` call server-side) so no second client fetch is needed — as a plain
signed delta, framed bidirectionally (`--positive`/`--negative`, unlike the moments ledger's
opportunity-only `+N`) since a rehearsal's outcome genuinely can be worse, not only better.
Two exits: `TRY ANOTHER LINE` re-invokes `api.rehearse` at the exact same
`(originTournamentId, originBoardNo, branchPly)` and navigates straight into a fresh attempt
— the literal "try this decision again," no detour through Analyze — and `Back to Analyze`
returns to the origin board's overview, where the just-finished attempt already shows up in
both history surfaces below.

Two history surfaces, both fed by one `api.rehearsals(tid, no)` fetch (`listRehearsals`,
ordered `created_at DESC, id DESC` — `created_at` is unix-seconds resolution, so `id` breaks
ties between attempts created inside the same second): a **per-moment rail** of small ticket
stubs under each `MomentRow`, filtered to that moment's own `branchPly`, and a board-wide
**YOUR REHEARSALS** panel listing every attempt regardless of branch point, uncapped ("no
cap, just scroll" — no truncation, no dedicated UI limit). In-progress attempts show up
too, as resumable links — otherwise reload survival would have nothing to be discoverable
*from* once a player has navigated away. The two surfaces deliberately differ in **voice**:
a rail stub wears the ticket-stub label idiom (tracked caps, `TRIED`/`IN PROGRESS`), while
the ledger's rows are sentence case (`From trick 5`, `In progress`) — they're entries in a
list of things that happened, reading with the mixed-case score cell beside them
(`1NT by W −1 · +50`), not labels. The panel HEADING keeps the caps; a row is not a heading.
A finished stub's **score is inked against your real table** — `--positive` green when that
line beat it, `--negative` red when it fell short, ordinary ink on an exact tie or while an
attempt is still in progress — sharing `rehearsalBeatsTable` with nothing else but agreeing
by construction with THE FIELD rail's dots below (same comparison, same two tokens), so the
two surfaces can't disagree about a line's colour. Colour is never the only carrier: the
stub's `aria-label` states the verdict in words ("beat your table" / "fell short of your
table"), which is also what keeps it honest under the colourblind suit palette — the
`--positive`/`--negative` pair sits outside that swap by design (see "Compare and the gate").
Once at least one rehearsal is `done`, THE CARDS
WERE WORTH's `.worth-stubs` panel grows a third stub for the best one (highest `scoreNS` —
unambiguous since the human is always N–S) as a full-width row beneath the PAR/YOUR TABLE
pair rather than forcing a cramped 3-up grid at the 390px smoke-test breakpoint, opting out
of that pair's subgrid row-alignment rather than fighting it (a different shape: no sealed
treatment, one aside line). Every finished attempt also marks THE FIELD rail itself: a small
dot per distinct rehearsal score, right on the SAME line as the real players rather than a
separate row (unlabelled, so it never fights the field dots' alternating contract-label
bands), coloured against your real table's own score — `--positive` green when a line beat
it, `--negative` red when it fell short, unmarked on an exact tie. The caption underneath
names only the colours actually on screen — a board where every attempt tied leaves the
caption off entirely, and one where every attempt landed on the same side of the table
mentions only that colour, rather than explaining a dot that isn't there.
`analyzeRail.ts`'s `railLayout` takes the
rehearsal scores as an optional third argument and folds them into the same lo/span the field
dots are measured against, so a rehearsal outlier stretches the frame exactly like a field
outlier would rather than clamping against a scale that never accounted for it. The rail
renders whenever there is a field to draw OR a rehearsal to mark (not just `field.length > 1`
as before), so a lone rehearsal against a single-table field still gets a rail to sit on.

**Repeat taps resume rather than pile up, and an explicit ✕ discards.** Both entry points fire
with no confirmation, so a player idly re-tapping PLAY FROM HERE at the same moment (or
scrubbing back to the same ply in THE PLAY lens) would otherwise mint a fresh, functionally
duplicate rehearsal every time — "no cap, just scroll" on the history surfaces makes that
clutter visible rather than hidden, which is what surfaced the problem. `createRehearsal`
checks for a still-`'playing'` rehearsal at the exact same `(originTournamentId,
originBoardNo, branchPly, userId)` first (`stmtInProgressAtPly`) and returns ITS
`{tournamentId, boardNo}` instead of creating another — a repeat tap reopens the one attempt
already in flight there, exactly like clicking its own rail stub would. `'done'` rows are
deliberately excluded from that check: once an attempt finishes, the same ply is open again
for a genuinely new line, which is the point of PLAY FROM HERE existing at all. This is
dedupe-by-resume, not dedupe-by-refusal, so it needed its own explicit escape hatch for a line
the player actually wants gone: `discardRehearsal` (`DELETE
.../rehearsals/:rehearsalId`) deletes the rehearsal's `boards` row then its `tournaments` row
in one transaction (`db.ts` sets `PRAGMA foreign_keys = ON`, so `boards.tournament_id` is
enforced and deleting the parent first would fail outright). Ownership is
re-verified against the CALLER's own `(originTournamentId, originBoardNo, userId)` rather than
trusted from the target row alone, the same discipline `listRehearsals`' join already uses.
Both `RehearsalRail` and `YourRehearsals` grow a small ✕ beside every stub/row; since a
`<button>` cannot nest inside the `<a>` a react-router `Link` renders, the two are siblings in
a small wrapper rather than one interactive element holding the other. The discard is
optimistic (the stub disappears on tap) and reconciles from a fresh `api.rehearsals()` fetch
only if the delete itself failed, so a genuine failure doesn't leave the screen silently out
of sync with the server.

One incidental fix that came out of building this: `submitCall`/`submitPlay`/`ensureAdvanced`'s
`recomputeElo()` trigger had no tournament-kind guard at all (`boardDone(b.row) &&
!isAiUser(...)`), so a demo exhibit finishing already triggered a wasted full Elo replay-sweep
today — harmless (the replay's own source query filters `kind = 'standard'`) but expensive.
Now gated on `b.tournament.kind === 'standard'` too, closing it for exhibits as well as
rehearsals — worth doing here specifically because rehearsals are explicitly uncapped.

**A crossing's number is its own sequence, not its row id.** `tournaments.id` is one
sequence shared by every `kind`, so each rehearsal — and, on `DEMO=1`, each exhibit —
consumes a number no tournament ever wears. Production had drifted to "Tournament #100" with
88 tournaments in existence, inflated by 13 Play-From-Here branches a player has no way to
know about, and since rehearsals are deliberately uncapped that drift has no ceiling.
`tournaments.number` carries it (NULL on every non-standard kind) and `db.ts`'s
`createCrossing(insert)` is the one way a crossing is ever made — all three creation sites
(`placeUser`, `demo-seed.ts`'s ambient tournaments, `demo.ts`'s `freshAiField`) hand it
their own INSERT as a callback and get the finished row back. The insert runs INSIDE that
transaction on purpose: numbering has to be a second statement (the row must exist before
`MAX + 1` can be written to it), and left outside, that second statement is optional in a way
nothing catches — the INSERT commits alone, so a throw, a crash, or simply a future creation
site that forgets the follow-up call strands a standard tournament with `number` NULL and
its placeholder name, which then renders as its raw id via `tournamentNo()`'s fallback.
Bundled, the row and its number commit together or not at all, and "create a crossing" has
no spelling that skips the numbering. A raw INSERT elsewhere could still bypass it; an
`AFTER INSERT` trigger is what would make that impossible, and is deliberately not done —
this codebase has no triggers and an invisible rewrite of a row's name is a poor thing to
discover. `web/src/format.ts`'s `tournamentNo()` still parses the number back out of `name`
and needed no change; sending `number` over the API and retiring both client-side regexes is
the natural follow-up, not done here.

**`MAX(number) + 1`, never a `COUNT` of the rows before it — this is the load-bearing
choice.** A count is a re-derivation, so it is stable only while no earlier standard row
ever disappears; the moment one does it hands the next crossing a number an existing row is
already displaying, silently. A sequence can only ever skip, and a gap in an identifier is
harmless where a duplicate is a lie. Nothing in the app deletes a standard tournament today
(the only `DELETE FROM tournaments` is `discardRehearsal`, rehearsal rows only — demo-seed's
wipe is unqualified, but runs on `DEMO=1` databases that restart from scratch), so both
rules are correct today — the point is that this one does not *depend* on that staying true,
which matters for an invariant otherwise enforced by nothing but a doc comment. The `UNIQUE`
index on `number` is the backstop that turns it from a promise into a guarantee: a restored
backup, a hand-edit on the volume, any future second writer all raise there instead of
shipping two crossings wearing one number. `server/test/crossing-number.test.ts` pins the
delete case specifically, since it is the one that used to fail silently.

**The id stays the ADDRESS, and that separation is deliberate.** `/t/:id/b/:no`,
`boards.tournament_id`, `elo_history.tournament_id` and `origin_tournament_id` are all raw
ids. Two things depend on it: rehearsals reuse the board route for free (`Analyze.tsx`
navigates a fresh branch straight to `/t/:id`, and a rehearsal has no number to put there),
and shared links keep working. Putting the number in the URL instead would be actively
unsafe rather than merely churn — numbers `1..N` overlap the id space, so an old `/t/50`
would resolve to a *different* tournament rather than 404. If it is ever wanted, the only
safe route is a new path prefix alongside the old one, since the two value spaces cannot be
told apart within one segment. (One caveat on "links keep working", predating this: SQLite
reuses a rowid freed by deleting the highest row, so discarding the newest rehearsal frees
its id for the next tournament created. Rehearsal URLs are not shared, so this is a latent
wrinkle rather than a live bug — but it is the reason the guarantee is worded as "shared
links", not "every id is forever".)

The backfill that renamed the existing rows IS that one-time `COUNT`, which is provably
right at the instant it runs: nothing has deleted a standard row yet, and it is the only
place the two derivations ever have to agree. Adding a column is also what gives an
otherwise data-only migration something structural to guard on, so it uses the same
`!tournamentColumns.has(...)` test as every migration above it rather than a
`PRAGMA user_version` stamp. That is not just tidiness — a version stamp is a one-way door:
it cannot repair a database it has already run against, and it makes a rollback lossy, since
rows created while the older code was live would be named by the old rule and then skipped
forever by the bumped counter. `ALTER` + backfill + index go through `db.transaction()`
rather than a `db.exec('BEGIN; … COMMIT;')` string, because SQLite's DDL is transactional
and a raw `exec` that throws mid-script leaves the `BEGIN` uncommitted — every later
migration, and then the whole process, runs inside that abandoned write transaction.

**Tournaments never close** (evergreen): `placeUser` in `tournaments.ts` resumes your
unfinished tournament first. Otherwise it serves a candidate from the last 30 days you
haven't played, in two tiers: a **grace window** force-joins young (< 48h), under-filled
(< 4 starters) tournaments so fresh ones collect a field instead of orphaning — ordered
**rescue, then fill, then freshness** by `graceOrder`, which is where nearly all the leverage
in placement sits (see "Tuning placement" below and its doc comment); then
candidates are scored `log(1 + distinct finishers) · e^(−age/τ)` and one is weighted-random
sampled from those near the top score. If nothing beats what a brand-new tournament would
score (`ln 2`), a new one is created — which the grace window then fills. All knobs live in
the `PLACEMENT` const in `tournaments.ts`. Tournaments older than the window are archived
from placement but stay resumable and completable via direct URL (boards deal lazily), and
still count in the Elo replay. Full design rationale: [TOURNAMENT-SELECTION.md](TOURNAMENT-SELECTION.md).

**Tuning placement: measure it, and know which number is already maxed.** `tools/calibrate_placement.mjs`
replays real demand through candidate policies; the trace comes from
`.claude/skills/player-outreach/scripts/placement_trace.mjs` (production read, scratchpad
only), or `--synthetic` needs no production access. Four things it established that are
easy to get wrong from first principles:

- **Mean humans per tournament cannot be improved.** A player never replays a tournament, so
  the tournament count is floored at *the busiest player's demand count* — and production
  sits exactly on that floor (90 of 90). Mean field is therefore pinned. The real objective
  is the DISTRIBUTION: `soloCrossings`, the crossings that end with no human to compare
  against. Production spends its mean as ten boards with one human and a tail out to seven.
- **The grace tier decides ~50% of placements and the scoring tier ~11%**, so the popularity
  score, `SAMPLE_RATIO` and `TAU_S` are near-inert at this scale — ablation moves them by
  0.0-0.2pp. Tune the grace tier first; it is where the leverage is.
- **Grace ordering is the lever, and it is SHIPPED** as `graceOrder` — rescue any board
  stuck at one player, otherwise top up the fullest, freshest only as a tiebreak. The two
  obvious orderings are each half right: FULLEST-first buys the best field depth and the
  worst loneliness (15 orphans vs the old rule's 10), since there is always something fuller
  to prefer over a board at one human; EMPTIEST-first inverts both. The composite wins
  because the goals only compete once every board has a second player. Measured against the
  real trace: orphans 10 → 7, fieldSeen 3.78 → 3.87, co-presence 41.3h → 22.6h. Note the old
  rule was OLDEST-first, which reads neutral but behaves like fullest-first — older boards
  have had the most time to fill. Full record in
  [TOURNAMENT-SELECTION.md](TOURNAMENT-SELECTION.md#grace-ordering-rescue-then-fill).
- **Read `fieldSeen`, not `meanField`.** `sum(f²)/sum(f)` is the field at the average
  CROSSING rather than the average tournament, which is what a player actually experiences.
  It is nearly INELASTIC (3.6–4.1 across every ordering) since only its concentration can
  move; solo rate and co-presence span are elastic, roughly 2× best to worst. So pick the
  ordering that fixes loneliness and co-presence without spending depth — `--sweep frontier`
  prints them together.

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
One exhibit overrides its tournament's claim rule, and it is the only one: `claim-on-call`
(`claimRule: 'optimistic'`) shows the claim ticket going up on a CALL, before a card is
played. That state is effectively unreachable under the shipped gate — a scan of 522 call
actions found it three times at `'optimistic'` and never at `'pessimistic'`, since it needs
the position settled inside the first trick. Legacy tournaments still use that gate and are
still resumable, so this is a real production state rather than a staged one, and the client
path it exercises (`submitCall` → `runClaim` → the announcement, rendered by `Board`'s own
`ClaimOverlay` because the board is still in the bidding view) is identical under both rules.
`ensureExhibitTournament` takes the rule as an optional argument for exactly this one case.

One gallery entry is not a replay recipe: `fresh-house-crossing` (`freshAiField`) mints a
brand-new STANDARD `ai_field = 1` tournament per click and lands the tester on board 1, so
the benchmark AI personas can be click-tested exactly as production behaves (exhibit-kind
tournaments deliberately never get AI rows, so a canned exhibit couldn't show this).
A second entry, `stale-board` (`desyncAfterMs`), is the one exhibit whose state a recipe
**cannot** produce: a refused play needs the SCREEN to be behind the server, and `Board.tsx`
GETs the board fresh on mount, so any staleness baked in before the navigation is gone by the
time the tester sees it. So the recipe is ordinary and the desync happens on the client —
`Scenarios.tsx` schedules `POST /api/demo/desync` on a bare `window.setTimeout` (deliberately
not an effect: the gallery unmounts on the very next line, and a cleanup would cancel the
thing being exhibited) and then navigates. That route plays the first card the caller could
legally play right now, through the same `submitPlay` as any other request, on a board they
own — exactly what a second tab does, so the 409 the tester then gets is genuine rather than
simulated. It answers `{ advanced: false }` instead of erroring when there is nothing to play,
since a click-testing aid that 500s on a lost race is worse than one that quietly no-ops.
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
with the same `stageBidSteps`/`stagePlaySteps` the live board uses (before those existed for
the auction it was a flat 500ms cut, which is still the reduced-motion path) and a captured
claim tail through the same `planClaim` three beats — lead, `ClaimOverlay`, `stageClaimSteps`
fast-forward — `Board.tsx` uses (see "Auto-play and claims" above; this capture's own tail
happens to be the mixed case, where the trick the last decision completes goes to the other
side, so the tour is a live exercise of the lead beat and `tour.test.tsx` pins that shape);
off-script selections show their real meanings but only the scripted line commits,
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

**Compare and the gate.** `/compare/:id` puts the viewer's record beside another player's, each
measure drawn as a bar tipping left or right from a centre line by the *margin*. Three facts
about it are load-bearing, and [docs/compare.md](docs/compare.md) has the full reasoning:

- **Every judged row carries a gate** — `GATE_SIGMA (1.0) × √(seA² + seB²)` — and a row whose gate
  exceeds its `fullTilt` is *set aside* rather than drawn, because it could never be called
  whatever the figures say. The error model differs per measure and two of them are easy to get
  backwards: rates use the binomial SE **with the Agresti-Coull adjustment** (`p̃ = (x+2)/(n+4)`),
  which is required rather than cosmetic — the textbook formula is exactly zero at p=0/p=1, and
  when this shipped 11 of the 24 players with any declared board sat at exactly 0% or 100% — while
  **bid accuracy** is the mean of a four-point discrete score (`gradeFromProbs`) and uses `σ/√n`,
  even though `bidTypes[]` one panel below it genuinely is binomial. `FULL_TILT` was measured
  against production (2026-07-31, n=5); it is load-bearing twice, since it scales every bar *and*
  decides what gets set aside. The provisional quota arrives as an **argument**, never read from
  the constant — the same `DEMO=1` trap that once made `entered-rankings` unreachable.
- **Direction is the encoding; colour only reinforces it.** `--positive` is byte-identical to
  `--suit-c` and `--negative` to `--suit-h`, and the colourblind suit palette rewrites the suit
  tokens while leaving these alone — so a red/green-only verdict would fail exactly the players
  that setting exists for. Flatten every fill to one ink and the screen must still read correctly.
- **The route is `/compare/:id`, deliberately not `/players/:id/compare`.** `isPublicPath` matches
  the `/players/` prefix with `startsWith`, so mounting it there would have made a viewer-scoped
  screen public *while `seo.test.ts` kept passing*, because the table and the gate would have
  agreed on the wrong answer. One endpoint (`GET /api/compare/:id`) builds both profiles under a
  single `memoizedStandings()` closure — two `playerStats()` calls would run `fieldPercentiles`'s
  site-wide sweep twice — and eligibility is settled with two cheap `COUNT`s first, so a pair below
  `COMPARE_MIN_BOARDS` (16, both sides) never triggers the expensive path.

**Elo is recomputed from scratch** every time a board completes: `recomputeElo` wipes
`elo_history`, resets everyone to 1200, and replays all tournaments **in tournament-id
order** (not timestamps). That's deliberate — a late finisher in an old tournament re-ranks
everyone — so don't "optimize" it into an incremental update without redesigning the model.

**The ladder's movement arrow is a real clock window, ranked over the rows on screen — and
both halves of that are load-bearing.** `leaderboardMovement(visible, {nowSec, provisionalMin})`
takes the visible ladder as an ARGUMENT because the version that didn't was the bug: it ranked
over everyone in `elo_history` while `/api/leaderboard` filters its rows (the provisional quota,
plus `ladder_listed` for anonymous callers), so a player the reader cannot see could push a
visible one down and a #2 on an eight-row ladder could wear "▼3". Its "window" was likewise the
crossing with the highest tournament id anywhere — usually somebody else's game, and unrelated
to elapsed time. Now it reports a 1-day and a 7-day figure (`MOVEMENT_WINDOWS`), both shipped on
every response so the client's switch costs no round trip, and the Rankings footer names the
period on screen.

The "then" rating is a SUBTRACTION, not a walk: `elo_history` has no timestamp and replays in
tournament-id order, so `after` can't be read off a date-sorted copy (see `eloProgression`) — but
a sum ignores order, so `users.elo` minus the points banked since the cutoff is the rating as of
the cutoff, exactly (core's `eloUpdates` rounds, so every value is an integer and the deltas
telescope). A crossing's finish time is `MAX(boards.updated_at)` for that (user, tournament), the
same bridge `stmtEloSeries` uses; the query prefilters by `idx_boards_updated` the way
`activity.ts` does, and spells out `kind = 'standard'` rather than relying on `elo_history` only
ever holding standard rows.

**A player who was not on the ladder at the cutoff is excluded from the "then" ranking
entirely**, not merely given a null of their own — and that is the one rule here most likely to
get "simplified" back out. Their reconstructed rating is exactly `ELO_INITIAL`, a phantom that
otherwise sits mid-ladder and displaces real players: three idle players and one newcomer
arriving beneath them would hand the bottom idle player a ▲1 for having played nothing.
Excluding is correct in both directions because competition ranking counts only players *above*
you. It follows that movement can differ between an anonymous and a signed-in caller, exactly as
that caller's rank numbering already does.

**A crossing's rating swings are shown per player, on the crossing itself** — the question the
ladder's arrow above deliberately does not answer. The tournament page's THE FIELD panel draws
each player's `after - before` for that tournament (`tournamentEloDeltas()` in `tournaments.ts`,
folded onto the standings by the `/api/tournaments/:id` **detail** route only — the lobby list
draws no swings and a player can hold hundreds of tournaments). `null` is not zero and never
renders as it: the three ways a player of a field can have no swing are that house personas never
rate, an incomplete player never rates, and a crossing rates nobody until 2+ humans finish it.
The column and its caption appear on the same test, so a crossing that has rated nobody keeps its
three-column field rather than growing a column of em dashes — and because that test is a
property of the CROSSING rather than of the viewer's progress, swings show on a live scoresheet
too, for players who finished ahead of you. Reading it costs `idx_elo_history_tournament`, the
tournament-first sibling of `idx_elo_history_user`; see the pair's note in `db.ts` for why one
index cannot serve both directions.

**Replay order is not play order, and every surface that draws a timeline has to convert.**
Tournaments never close, so a player can be placed into a months-old tournament or resume one
they abandoned in the spring; its id is low but they finished it today. Two consequences, and
both have bitten:

- **Order by `finishedAt`, never by tournament id.** `finishedAt` is this player's last
  completed board of that tournament, and it is the ordering key for all three of `stats.ts`'s
  chart series (see `StatPoint`'s doc comment) as well as `activity.ts`'s `byFinish`. Ordered by
  id, a crossing finished today draws to the left of one finished weeks earlier and the charts'
  x axis stops being time — a rise between two points would mean nothing but the numbering.
- **Re-sorting rows is not enough for a RATING, because `after` is a running total over the id
  order.** The last row by date carries a rating that omits every higher-id crossing, so the
  line would end somewhere the player hasn't been since June. `eloProgression()` (`stats.ts`)
  therefore moves the per-crossing *deltas* (`after - before`) and re-accumulates them from
  `ELO_INITIAL` in play order: the line starts at 1200 and, since a sum ignores order, ends at
  exactly `users.elo`. `totals.peakElo` is read off that same reconstruction rather than off
  `elo_history` — the two maxima can differ and neither dominates, so taking the chain's would
  sometimes print a PEAK the drawn line visibly rises above. `activity.ts`'s `peak-rating`
  milestone makes the identical reconstruction so the two screens can't disagree about a peak.
  It is a reconstruction either way, which the chart already discloses; this one reconstructs
  the player's history rather than the replay's bookkeeping, and for a player whose play order
  matches id order (most of them — placement serves recent tournaments) it returns the raw chain
  unchanged.

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
it. `tournaments.ts`'s `provisionalMin()` is the one place `DEMO` is consulted for that quota —
`app.ts` imports it and passes the answer to `/api/leaderboard`'s movement math, to `activity.ts`
and to `compare.ts`, so no consumer re-derives it; `activity.ts` and `stats.ts` read no env at
all. Note it
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

**Medal progress (the loyalty rail):** a Home-screen widget that rewards continuous play
with a suit medal at the 4th, 25th, 100th and 500th completed tournament — ♣, ♦, ♥, ♠, in
that order. The tier math itself (`packages/core/src/medals.ts`'s `computeMedalProgress`)
is pure and dependency-free like the rest of core; it takes two counts and the
boards-per-tournament constant as plain arguments rather than reading anything, so neither
core nor its tests know about SQL, `/api/me`, or `BOARDS_PER_TOURNAMENT`'s home in
`db.ts`.

Two counts feed it, kept deliberately separate — this is the same trap the activity
feed's milestones and the leaderboard's `rated_tournaments` already navigate, so medals
reuse the same discipline rather than inventing a third meaning for "how many
tournaments":

- **`tournamentsCompleted`** (`server/src/stats.ts`'s `completedTournamentCount`, modeled
  on `activity.ts`'s `stmtAllCrossings` — group by tournament, keep only groups where
  every board is `done`) is the **authoritative** count. It alone decides which medals are
  colored in and exactly how many tournaments remain, and it is deliberately **not**
  `playerStats().totals.tournamentsCompleted` (that one only falls out of a full
  `standings()` sweep — too expensive for something `/api/me` computes on every load) and
  **not** `rated_tournaments` (gated on ≥2 human finishers posting to `elo_history` — a
  stricter, different set that exists only for ladder eligibility).
- **`totalBoardsCompleted`** (the existing `completedBoardCount()`, already public via
  `/api/me`'s `user.boards`) only ever smooths the **bar**: a player mid-way through their
  4th tournament sees it climb board by board, even though the club medal itself doesn't
  color in until that 4th tournament actually finishes. `computeMedalProgress`'s `pct` is
  measured from **zero tournaments**, not from the previously-earned tier, so crossing a
  threshold never resets the bar — the moment club is earned (4 tournaments = 16 boards),
  the bar already reads 16/100 = 16% toward diamond (25 tournaments = 100 boards), not
  0%. Because the two counts can drift apart (many tournaments left half-finished at once
  inflate boards without completing any of them), `pct` is capped at 99 while the tier
  isn't actually earned — the one defensive rule in the whole function, there because a
  full bar next to a still-grey medal would read as a bug.

`tournamentsRemaining` is likewise **exact**, off `tournamentsCompleted` alone
(`threshold − tournamentsCompleted`) — never derived from boards, so the widget's own
copy ("Complete 2 more tournaments to join the rankings") can't drift from what the medal
itself is actually waiting on. That first medal's copy is deliberately not generic: on a
deployment where 4 completed tournaments is also the leaderboard threshold
(`tournaments.ts`'s `provisionalMin()`, production default `PROVISIONAL_MIN_TOURNAMENTS`),
"join the rankings" is literally true rather than flavor text, and `MedalBar.tsx`'s copy
says so. But `DEMO=1` relaxes that quota to `DEMO_PROVISIONAL_MIN_TOURNAMENTS` (1) — the
identical trap the activity feed's `entered-rankings` milestone was built to avoid — so by
the club tier a demo player is typically already ranked, and the sentence would be making
a false claim in exactly the environment used for click-testing it. `/api/me` therefore
sends `provisionalMin` (alongside `compareMinBoards`, the same "send it rather than
hardcode it" pattern) and `MedalBar.tsx` only uses the rankings phrasing when it equals
the club tier's own 4-tournament threshold, falling back to the ordinary glyph phrasing
otherwise. Every other tier just names its glyph ("earn the ♦ medal") rather than
spelling out "Diamond"/"Heart"/"Spade" — the colored mark beside the sentence already
says which one.

**Human-only**, the same gate Elo and placement already use: `server/src/medals.ts`'s
`medalProgressFor` returns `null` for `kind !== 'human'`, and `stats.ts`'s `playerStats()`
zeroes `totals.earnedMedals` the same way for a house profile — the benchmark AI personas
can churn through hundreds of tournaments and never show a medal.

**No new persisted column.** Like `tournamentsCompleted`/`completedBoardCount`
themselves, a medal tier is derived fresh on every read rather than diaried — the
evergreen, recompute-on-read discipline the rest of this codebase already follows for
Elo and placement. There is no "you just earned a medal" toast or celebration moment in
this first pass; a medal simply appears colored the next time the rail or the profile
loads, the same way a new `elo_history` row silently updates the RATING chart. "Next
load" has to mean within the same session, not just after a hard reload: `Board.tsx`
otherwise never touches `MeContext` (it reads `bidFeedback`/`doubleTapBid` off it but never
writes), so without an explicit trigger the Home rail would show a stale bar/medal for the
rest of the visit — including at the exact moment a medal is earned, the one moment this
widget most wants to be right. So the same effect that flips on the toll receipt
(`Board.tsx`'s `showReceipt` effect, keyed on the board's `state` going live → `'done'`)
also calls `refresh()` when the board that just finished was the tournament's **last**
one (`board.boardNo === board.totalBoards`) — an ordinary mid-tournament board finishing
doesn't touch account state and skips it.

**Two call sites, two shapes.** `/api/me`'s `medals` field
(`server/src/medals.ts`'s `medalProgressFor`) is the full `MedalProgress` — earned suits,
the current target, the bar's `pct`, `tournamentsRemaining` — because Home's `MedalBar`
needs all of it. `playerStats()`'s `totals.earnedMedals` is just the earned list, computed
inline from the `tournamentsCompleted`/`boardsCompleted` that function already has in
hand for whichever profile is being viewed (self or someone else's) — no second query —
because the profile (`Player.tsx`'s `MedalGlyphs earned={...} mode="earnedOnly"`) is
deliberately a trophy case: only what's been won, no bar, no bounding box, no caption.
`MedalGlyphs`' other mode, `mode="all"`, is what `MedalBar` uses for Home's rail — all
four suits always render, close together, colored once earned via the app's existing
`.suit-s/.suit-h/.suit-d/.suit-c` classes, unearned ones muted via `.medal-glyph-locked`
(`var(--line)`) — the exact "earned in real color, rest muted" idiom `StarGrade.tsx`
already established, reused rather than reinvented. Suit coloring goes only through the
existing `--suit-*` tokens, so night mode and the colorblind palette need no extra work.

**The bar's outline is a deliberate borrow from `TrickArea.tsx`'s trick-meter** — the bar
in the middle of the card-play screen — rather than `PctBar`'s borderless track:
`.medal-bar-track` takes the same `1px solid var(--ink)` structural border. The unfilled
remainder is a flat `--chart-track` fill rather than the trick-meter's diagonal hatch,
though — `PctBar`'s plainer "nothing here yet" convention, not the trick-meter's. The
fill's growing edge is capped with the same `1px solid var(--ink)` line trick-meter uses
to keep its own hatched fill's leading edge crisp against the track
(`.medal-bar-fill.capped`, gated on `fillPct > 0` — the same `tricks > 0` gate
trick-meter's own cap uses — so a brand-new 0% bar shows no stray line at the left edge).
The percentage itself is rendered in plain body weight next to the bar, never as a bolded
standalone figure — `.num`'s doc comment explains why: Besley's tabular-figure feature is
broken in every published build (a font bug, not a design choice), and bolding a raw
number invites exactly the "why does one digit look heavier" problem that comment warns
about.

**The widget itself is unboxed** — no panel background or border, just page-level
padding (`.medal-bar`) — and it sits on Home between the "play" block (the OPEN NOW/KEEP
GOING card) and TOLLS PAID, reading as the bridge between what a player is doing now and
what they've already finished. A dashed "TOURNEY ?" hint used to sit in that gap,
sealed shut ("Opens when you finish #N — one crossing at a time") since placement is
scored, not sequential, and the next tournament's number is unknowable in advance. Cut:
it said nothing actionable on any of the dozens of times a returning player would see it,
its dashed "?" risked reading as an unfinished placeholder rather than a deliberate seal,
and the "one crossing at a time" argument it was making is already made once, elsewhere
(the landing page, the first-crossing tour) — the same reasoning that cut the old
onboarding pamphlet for being redundant by the time anyone read it twice.

**Held back until the first board is on the books.** `Lobby.tsx` gates the whole widget on
`me.user.boards > 0` (`completedBoardCount`, the same count `/api/me` already sends for
Compare's entry-point gate) alongside the existing `medals` null-check, rather than
rendering a 0%-toward-club bar the instant an account exists. A brand-new player hasn't
earned anything and hasn't even seen a deal yet, so a progress rail at that point has
nothing to show and reads as clutter ahead of the first crossing rather than as an
incentive during it — the same instinct that cut the old "TOURNEY ?" hint above. The gate
is on boards, not tournaments, so the widget appears as soon as the player's first board
finishes rather than waiting for their whole first tournament (four boards) to close.

**Hand-flip subtlety:** the human sits South, but when North (the robot partner) declares,
the human plays the North hand — see `humanControls` and the `flipped` handling in
`game.ts`/`boardView` and the Board page. Touching seat/turn logic? Test both orientations.

**better-sqlite3 is synchronous:** DB calls are not awaited; prepared statements live as
module-level constants next to the functions that use them. Match that style.

**One sheet, three widths.** The app was drawn for a 390px phone and `.shell` was a hard
`max-width: 430px`, so on a tablet or a desktop it was a ribbon in an ocean of paper. It now
steps, and the whole mechanism is one token plus three numbers, declared together under "the
responsive ladder" at the top of `web/src/style.css`:

- **`--shell-max` is the width of the sheet**, and `.shell` reads nothing else. The base is
  430px — the phone, unchanged to the pixel — stepping to 600px at 720px of viewport and
  680px at 1024px. A screen that wants a different measure overrides the TOKEN
  (`:root:has(.board-page)`, `:root:has(.stats-page)`), never `max-width` somewhere the next
  reader won't find it. Matched on `:root` rather than on `.shell` because `--card-h` is
  declared there and is read by the card clones `TrickArea` appends to `<body>`, outside
  `.shell` entirely. Where `:has()` is unsupported the overrides drop and every screen wears
  the generic ladder — narrower, not broken, which is why the ladder holds the default and
  `:has()` holds the exceptions.
- **The three breakpoints are 720 / 1024 / 1400, and they are content breakpoints.** 720 is
  where 430px of content starts reading as a ribbon; 1024 is where a second column of panels
  is affordable; 1400 is where growing the measure only makes lines harder to read. There is
  no CSS-native way to name a breakpoint, so those numbers appear literally in every `@media`
  block in the file — `grep -n 'min-width: 720px'` finds every rule at a step. **Do not
  introduce a fourth number** without adding it to the ladder's comment.
- **Mobile-first, strictly.** Every rule outside a `min-width` query is the phone design,
  untouched; every responsive rule is additive. That is what makes "did I regress the phone?"
  answerable by reading a diff instead of by re-shooting every screen.

**Cards size from the sheet, and from the viewport's HEIGHT.** `--card-h`'s fit formula now
measures `min(100vw, var(--shell-max))` instead of a hardcoded 430px, so a wider sheet buys a
bigger fan rather than a bigger empty gap; `--card-h-cap` goes 82.5px on the phone to 118px past 720. The `vh`
term in that cap is the part worth understanding: phones are portrait and desktops are
landscape, so the moment the app claims desktop the scarce axis flips from width to height.
The play screen stacks dummy, the table and your own fan — about 3.6 card heights plus ~390px
of chrome — so a 900px-tall window affords roughly 140px of card and a 700px one about 85.
Sized on width alone, a wide-but-short window gets beautiful cards and a hand that scrolls off
the bottom. `FAN_GAP` (`fanLayout.ts`) deliberately stays a fixed 6px at every size: it is the
whitespace between two printed values rather than a share of the card, and scaling it would
make the fit formula's own constant circular.

**The board stays one centred column; the profile becomes a two-page spread.** Those are the
two shapes, and which one a screen takes is a content decision, not a width decision. The
board is auction over decision over hand at every size, so it caps everything — tray, notices,
meaning panel, bid grid — at one 34rem column and gives the leftover width to the cards; its
trick table caps at ~6.4 card widths, because the four seats are pinned to that box's own
edges and a sheet-wide box would put East a hand's breadth from West. The profile is a dozen
small panels, so at 1024 it becomes a grid with the masthead spanning both columns and the
panels' own existing `margin: 12px 16px 0` doing the gutters. Two traps live in there, both
recorded beside the rules: `.board-page .trick` beats a one-class `.trick { margin-inline:
auto }` in the cascade, and a flex item whose cross size is `auto` is *stretched*, so auto
margins have no free space to absorb until you give it `width: 100%`.

**The three hand-rolled charts scale uniformly now.** `Sparkline`, `StemChart` and `DayGrid`
were drawn against a 326-unit design width and stretched on x alone
(`preserveAspectRatio="none"`), which is invisible at 326-in-330 and indefensible at
326-in-960: the toll log's days became 3:1 lozenges and the stem chart's `<text>` labels were
drawn stretched, since a non-uniform viewBox scales glyphs too. They now scale on both axes
(`height: auto` in `style.css`), so a wider panel makes the whole drawing bigger.

**Reviewing a breakpoint change:** `node scripts/responsive-check.mjs http://localhost:3000
./shots` walks the app once against a `DEV_AUTH=1` server and shoots every screen at 390, 834,
1194 and 1440, as `<name>@<width>.png`. The 390 column is the regression net — nothing in it
may change.

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
`ADAPTIVE_NIGHT_END_HOUR` in `theme.ts` (7 PM–8 AM, close to but wider than the
industry-standard fixed dark-mode schedule — e.g. Windows Night Light's default "set
hours" of 9 PM–7 AM — rather than a sunset/sunrise calculation, since that needs
geolocation this app doesn't request); a
60s timer in `App.tsx` re-applies it so a tab left open across the boundary still flips
live, the same problem `system`'s `matchMedia` listener solves for OS changes. A
blocking inline script in `web/index.html` applies the persisted choice before first
paint — keep it in sync with `theme.ts` by hand, since it has to run before the module
graph loads. The `@media (prefers-color-scheme: dark)` copy of the night token block is
scoped to `:not([data-theme])` so it never fights an explicit override — if you add a new
base token, add it to both the `[data-theme="night"]` block and that media copy.

**The colorblind suit palette is a second, independent device-local axis, not a third
theme.** `data-suit-palette="colorblind"` on `<html>` (`suitPalette.ts`, `nb:suitPalette` in
localStorage) composes with `data-theme` rather than replacing it — a colorblind player
wants both a day AND a night variant of a safe palette, the same way a sighted player wants
both variants of the standard one, so this could not be a fifth `THEME_OPTIONS` entry.
Standard red/gold hearts and diamonds are a known collision under red-green colorblindness
(~8% of men); the colorblind palette swaps ONLY `--suit-h`/`--suit-d` (day: `#0a5c99`
"stamp-ink blue" / `#98490a` "rust orange"; night: `#6fb3e0` / `#e0995a`, lighter for the
dark stock) to a blue/orange pair — the conventional accessible substitute, since blue and
orange sit on the tritan axis red-green deficiency leaves intact — and their
`--cardface-suit-*`/`--onprimary-suit-*` derivatives; `--suit-s`/`--suit-c` are untouched,
since clubs already sits off the red-green collision axis. Three override blocks in
`style.css`, mirroring the night-mode shape exactly one level down:
`[data-suit-palette="colorblind"]` (day — redeclares `--cardface-suit-h`/`-d` as literals,
since the day cardface tokens are pinned literals rather than `var()`-chained),
`[data-theme="night"][data-suit-palette="colorblind"]` (night — does NOT redeclare
`--cardface-suit-h`/`-d`, since the night block already chains them to
`var(--suit-h)`/`var(--suit-d)` and they inherit the new value automatically; redeclaring
would be the same hand-drift risk already flagged for `--onprimary-suit-*` above), and a
`@media (prefers-color-scheme: dark)` mirror for `SYSTEM` appearance. That mirror is the one
place order, not specificity, decides the outcome: it and the pre-existing standard dark
mirror are both equal-specificity overrides of `:root`, so the colorblind mirror MUST stay
textually after the standard one in `style.css` (see the block comment above both) — get
this backwards and a colorblind player on system-dark OS with Appearance left at SYSTEM
silently sees the original night red. `e2e/smoke.spec.ts` has a computed-style test under
emulated dark `colorScheme` for exactly this combination, since an attribute-presence
assertion can't catch a regression of file order. Applied the same way appearance is: once
by a second blocking inline script in `index.html` before first paint (its own try/catch —
a failure in one script must not block the other), and again by `applySuitPalette` when the
settings gate's switch is flipped; unlike `theme.ts` there is no `system`/`adaptive`
equivalent to re-apply on a timer, since there's no OS media feature for color-vision
deficiency and no time-of-day concept for it.

**The settings gate** (`web/src/pages/Settings.tsx`, the sixth tab) is one perforated panel
of identical rows — tracked-caps label, the italic aside that says what the setting does,
then a full-width `.pref-switch` segmented lever (`ds/PrefSwitch.tsx` — Analyze's lens
switch uses it at three). Four segments for appearance, two for a
switch: the SAME component at different arities, deliberately, which is why the design
system still has no on/off toggle. Night mode and sign-out moved here off the Stats page,
which is the ledger and now holds nothing that isn't a record of play.

**Where a preference lives is a decision, not an accident.** The account rows are columns on
`users` (`auto_claim`, `ladder_listed`, `bid_feedback`), written through one partial-update
endpoint, `POST /api/me/prefs` — a route per switch doesn't pay for itself when the list is
plain per-user booleans and still growing (`difficulty` is already a column waiting for a
UI). Absent keys are left alone; an unknown key or a non-boolean is a 400, so a typo can't
look like a successful write. Appearance and suit colors are the TWO device-local rows, and
only because they have to be applied before first paint by an inline script in `index.html`
— no round trip can answer in time, and both `SYSTEM`/`ADAPT` and a colorblind palette are
per-device ideas anyway. The footer says that once rather than tagging rows. Each of the
newer settings has one thing worth knowing:

- **Settled tricks** (`users.auto_claim`, default FAST FORWARD) decides whether the server
  fast-plays a tail the player has no decisions left in, or hands it back to them
  (PLAY THEM OUT). It is a **server** preference, unlike every other row here: it is read in
  `advanceRobots`, where a claim is decided, not by anything on the client.
  This row replaced "Fast forward settled tricks", which chose between a compressed replay
  and one at table speed. That question stopped being the interesting one: what a player can
  actually choose is whether the tail is taken off them at all. `stageClaimSteps`' `fast`
  argument survives as an internal pacing knob rather than a preference — `planClaim`'s tail
  passes `true`, its **lead** deliberately passes `false` (that trick is ordinary play, not
  the claim), and `Board.tsx`'s `applyBoard` branch takes the `false` default but only ever
  runs as `runClaim`'s own fallback, where it emits nothing.

**A claim can arrive on a CALL, not just a card play**, and that path needed its own wiring.
The auction ends, the robots play on, and if the position is settled from the first card the
response comes back already `claimed` — no card was ever tapped. `submitCall` therefore
dispatches to `runClaim` exactly as `submitCard` does. That alone is not enough: `runClaim`
holds `prev` on screen until its last beat, so during the announcement the board is still the
BIDDING view, and `ClaimOverlay` renders inside `PlayPhase`. The overlay cannot simply move up
to `Board` — `PlayPhase` is exported, and Tour/Analyze mount it through `useReplay` — so
`Board` renders a second one, guarded on `board.state !== 'playing'` so the two can never both
appear. Before this, such a board jumped from the auction straight to the toll receipt with no
announcement at all (it did NOT mis-pace a replay, despite appearances: `stageClaimSteps`
returns `[]` outright when `prev.state !== 'playing'`). Rare — post-gate it needs a position
already settled inside the first trick — which is exactly why it went unnoticed, and why
`board.test.tsx` now pins it.
  **The setting only exists because the claim gate is pessimistic.** Under the old gate a
  claim genuinely changed the outcome — it played the human's remaining decisions correctly
  on their behalf — so letting one player opt out would have handed two players on the
  identical board different games because of a checkbox, and fed that into matchpoints and
  Elo. Invariant 1 records that toggle as rejected for exactly this reason, and the reasoning
  was right. Once a claim requires the position to be settled under EVERY legal card, opting
  out cannot move a score: every tail scores the same. Measured cost to a player who opts
  out: about 2 extra taps per claimed board (p90 4, max 7) — most of a settled tail is robot
  cards or single-legal-card turns that auto-play.
  **It is ignored on `'optimistic'` tournaments**, which claim for everyone regardless. There
  the old reasoning still holds in full, so honouring the checkbox would reintroduce the
  precise unfairness it was rejected for. `advanceRobots` checks the rule first and the
  preference second, which also means a player who has opted out never pays for the
  invariance search. One knock-on worth knowing: a board played out this way finishes with
  `claimed_at_ply` NULL, so Analyze and "Play From Here" fall back to `deriveClaimBoundary`
  and find the same ply anyway — it looks for where the position became SETTLED, not for who
  played it. Both then treat the tail the same as a claimed one, which is right (nothing
  there can change the result); `rehearsal.ts`'s refusal is worded for both cases.
- **Name on the ladder** (`users.ladder_listed`, default on) governs whether `/api/leaderboard` includes this
  player for an **anonymous** caller. That is the whole of it because the ladder is the
  whole anonymous surface: profiles already refuse a signed-out caller for every human and
  the activity feed is gated. A signed-in caller always sees the full field — the people
  you are matchpointed against can see who is in it. Ranks come from array position
  (`Leaderboard.tsx`), so an omitted player leaves no gap; a signed-out visitor's #3 can
  differ from a signed-in one's, which beats a hole in the numbering advertising that
  somebody opted out.
- **Bid feedback** (`users.bid_feedback`, default on) gates only whether the post-call
  grading toast (`GradeToast`, driven by `lastEval` in `Board.tsx`) renders — it is
  deliberately excellent for a learner and unwanted noise for a stronger player using the
  app to compete rather than study. Grading itself is computed and stored unconditionally
  by `submitCall` on every call regardless of this flag (`bidEvals`, the bid-accuracy stats
  pools, and the post-board "YOUR BIDDING" review table all stay populated either way) — the
  server never sees this preference and nothing about scoring or Elo changes. `Board.tsx`
  substitutes `null` for `lastEval` at both the `BiddingPhase` and `PlayPhase` call sites
  when the setting is off, which lands on exactly the same "nothing graded yet" branch those
  components already have, so there is no new empty state to design. `Tour.tsx` is
  unaffected: it carries its own scripted `lastEval` and never reads this preference, since
  the tour's pedagogical point is teaching the grading loop regardless of the visitor's (or
  signed-in tester's) own setting.
- **Beta features** (`users.beta_features`) is the odd one out: every switch above describes
  how an already-shipped feature behaves for this person, while this one GRANTS access to
  features still being tried out ahead of a general release. Nothing is gated behind it today
  — Analyze (the post-board review screen, `pages/Analyze.tsx`, plus its "Play From Here"
  rehearsal routes) was the first and only feature to use it, and has since shipped to
  everyone (see "Analyze" and "Play From Here" below); the column and the Settings row stay so
  the next feature that wants a narrow test population has a mechanism ready. Its default is
  environment-dependent rather than a fixed literal: the `beta_features` migration in `db.ts`
  computes it once, from `DEV_AUTH`/`DEMO`, and bakes that into the column's SQL `DEFAULT` —
  so it's simultaneously the backfill for existing rows on whatever deployment runs the
  migration AND, because SQLite reuses an `ADD COLUMN` default for every future `INSERT` that
  omits the column, the default for every signup after it with no second code path. Off in
  production (nobody has asked for early access to anything), on wherever `DEV_AUTH` or `DEMO`
  is set — PR previews and the permanent demo app share that exact shape (`ci.yml`'s
  `deploy-preview`/`deploy-demo`), so testers and click-testers see whatever's next without
  hunting for a switch. A production account would reach a beta feature only by deliberately
  flipping this switch — the intended path for a named handful of early testers, not a general
  release. The pattern Analyze's own gate followed while it was live, and the one worth
  repeating for the next beta feature: check BOTH the door (hiding the entry point in the web
  client) and the data (the route itself refusing an account that hasn't opted in)
  independently — the client hiding a door is only a courtesy, and a route that trusts it is
  one curl command away from everyone.
- **Double-tap to bid** (`users.double_tap_bid`, **default OFF**) is the one switch on this
  panel that does not preserve prior behavior — every other row above defaults to whatever the
  app already did, so it reads as a way OUT rather than a change. This one exists because it
  IS the change: player reports of accidentally submitting a bid on the bid box's tap-again
  shortcut are what shipping it off by default fixes. `BidBox.tsx` itself has never
  distinguished select from submit — every tap just calls `onSelect`, and the caller decides
  what a repeat tap on the already-selected call means. `Board.tsx` reads the preference
  (`me?.user?.doubleTapBid === true`, fail-CLOSED unlike the `!== false` reads above) and only
  submits on a second tap when it's on; the confirm CTA ("BID X →") is unconditionally the
  other, always-available path to the same `submitCall`, so turning this off never removes the
  ability to bid, only the shortcut. Scoped to bidding only — card play's own tap-again-to-play
  gesture (`HandFan`/`onSelectCard`) is a separate code path and is untouched. `Tour.tsx` does
  not read this preference either: its own `onSelectCall`/`attemptCall` only "submits" the one
  scripted correct call per decision point regardless of tap count, so a signed-out visitor
  walking the practice deal is not exposed to the mistap this setting guards against in the
  first place.
- **Trick clearing** (`users.trick_clear_mode`, TEXT `'auto'`/`'tap'`, default `'auto'`) picks
  how a completed trick leaves the table. `'auto'` is the pre-existing behavior: playAnim.ts's
  `stagePlaySteps` holds the four played cards for `GLIDE_MS + HOLD_MS`, then sweeps them to
  the winner on a timer, exactly as it always has. `'tap'` holds that same step open
  indefinitely instead of timing it out, until the player taps/clicks/Enters/Spaces on the
  trick area (`TrickArea.tsx`'s `.trick` box — never a hand fan, which is a separate sibling
  element). The one step this can hold is marked `holdForClear` on the `StagedStep` playAnim.ts
  emits; `Board.tsx`'s `scheduleSteps` splits the array on that marker (only when
  `trickClearMode === 'tap'`) rather than batch-scheduling every step's timer up front as it
  always did — the segments before and after the mark keep that exact original batch timing,
  so `'auto'` mode (where the split never triggers) is untouched byte-for-byte. Deliberately
  scoped to ORDINARY play only: `stageClaimSteps` never sets `holdForClear`, so a claim's lead
  and fast-forward tail both ignore this setting regardless of its value — gating up to 13
  tricks nobody has a decision in on a tap would fight "Settled tricks"' entire
  purpose, and the claim's own announcement already holds the board deliberately. Purely a
  client pacing preference — the server never reads `trick_clear_mode` and scoring/robot
  play/claim resolution are unaffected either way.
  **Unlike every other staged sequence on this page, it holds even under
  `prefers-reduced-motion`/no-WAAPI** — it is a reading pause on a real tap, not an animation,
  the same argument `CLAIM_ANNOUNCE_HOLD_MS`/`CLAIM_LEAD_SETTLE_MS` already make for the claim
  announcement. `Board.tsx`'s `applyBoard` normally only computes a staged sequence at all when
  `motionOK()` is true (every other setting on this page genuinely
  has "no replay to pace" without motion); an explicit `holdsOnTapWithoutMotion` clause computes
  `stagePlaySteps` for an ordinary-play transition regardless, so its `holdForClear` step still
  exists to hold on. Every OTHER step's `delayBefore` is then collapsed to 0 when `!motionOK()`
  — nothing to animate, so the burst up to the hold lands as fast as a render allows, and only
  the held step itself still waits on a tap. Without this, a reduced-motion player who turned
  "Trick clearing" to `tap` would see it silently do nothing — the trick would clear the instant
  the response landed, same as `auto` (actually faster, since even `auto`'s timed hold is
  skipped under reduced motion) — which directly contradicts the setting's own purpose for
  exactly the population likeliest to want a manual, unhurried pause.
- **Trump placement** (`users.trump_placement`, TEXT `'suit'`/`'left'`, default `'suit'`)
  decides whether a hand always reads ♠♥♦♣ or promotes the trump suit's block to the
  front once the contract is settled. Repeatedly requested by players, and a genuine
  playing aid rather than decoration — the suit you are counting is the one your eye
  should land on first. `api.ts`'s `suitDisplayOrder`/`displaySort`/`trumpForDisplay`
  are the whole of the ordering, in one place, because the fan, a partner's dummy fan,
  the E/W `DummyRail` and Analyze's suit lines all have to agree: a hand that reads
  trump-left in the fan and ♠♥♦♣ in the rail beside it is worse than either alone. The
  other three suits keep their relative order rather than rotating (rotating would sit
  ♥ next to ♦ on two contracts in four). `trumpForDisplay` also owns the one conversion
  worth centralising — `strain` counts ♣♦♥♠NT and suits count ♠♥♦♣, so it is `3 - strain`,
  and getting it backwards promotes the wrong suit rather than failing.

  **The re-sort is animated, once, and only where it was watched.** "The Draw"
  (`components/game/trumpDraw.ts` — the pure timing; `HandFan.tsx` — the DOM) slides the
  other suits right to open a gap, then draws the trumps in one at a time, highest first.
  It was chosen from three motions prototyped in `docs/trump-placement-concepts.html`
  (all three still run — open it): it is the only one that says WHICH suit changed the
  order rather than just that the order changed. Two structural things about it:

  - **It starts from an order that was never painted.** The fan the auction ended with
    belongs to `BiddingPhase` and the one that re-sorts belongs to `PlayPhase`, so there
    is no previous render of the same element to FLIP away from. `HandFan`'s `drawIn`
    makes the MOUNT supply it: first render in suit order, layout effect measures and
    drops the flag, re-render lands trump-left, and the animation runs from the measured
    delta — one motion, from a position that existed only between two layout passes.
    `drawIn` is captured in the `useState` initializer, so a flag left true for the rest
    of the board can never re-sort a hand twice.
  - **It gets its own beat, and pays for it.** `stagePlaySteps`' new `resortMs` argument
    delays the opening lead by the Draw's own duration — without it the lead glides in
    350ms later, over a hand still sorting itself, and the motion that teaches something
    loses. Board.tsx is the only caller that passes it (it is the only one that knows the
    preference), and `drawDuration` returns 0 — so the pacing is byte-identical to before
    — for a no-trump contract, a spade contract, a hand with no trumps, and any hand
    already in the right order.

  Everything else arrives already ordered and animates nothing: dummy is tabled after the
  opening lead, the E/W rail is four stacked rows (so "left" is "top" there), and Analyze
  applies the reader's preference statically to a board they are scrubbing. `Tour.tsx`
  reads no preference at all, the `doubleTapBid` precedent. **The fan is inert while the
  Draw is in flight** — a card in motion is not a card you can tap, which is the rule the
  staged snapshots already enforce by dropping `legalCards`; the Draw needs its own guard
  because the case they do not cover is the player being on LEAD, where there are no robot
  cards to stage and the fan arrives live with the trumps still travelling.
- **Suit colors** (`nb:suitPalette`, default STANDARD) is the settings-gate row for the
  colorblind palette — see "Night mode" above for the full token-swap story. The one thing
  worth knowing here specifically: it is NOT in `AccountPrefs`/`POST /api/me/prefs` at all,
  unlike the bullets above it — its `onChange` is the same synchronous set-state/store/apply
  triple Appearance uses, with no server round trip, no optimistic revert, and no
  `prefError` path to wire up.

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
- **A returning player never sees the prerendered markup.** It is a fallback for agents
  that can't run JavaScript, and React throws it away on mount — which on `/` means a
  signed-in player refreshing the lobby watched the landing pitch paint and then be
  replaced by the app. (For a search arrival the same swap is roughly the same words
  twice, so it reads as the page finishing rather than as a flash.) So a third pre-paint
  inline script in `web/index.html` sets `data-returning-player` when `nb:lastVisit` is
  stamped — `splash.ts` writes it on every authenticated mount — and the prerendered
  `<style>` hides its own `.pr` article under that attribute. Scoped to `.pr`, never
  `#root`, which React empties and refills. The suppression is per BROWSER and covers
  **every** prerendered page, the glossary's ~126 included: they flash the same way, and
  the trade is that a browser currently (or recently) signed in loses the static paint
  everywhere — including on a term page reached from search — while one that never has,
  or has since signed out, keeps it everywhere. That falls the right way round, since the
  blank is already what a signed-in browser gets on every other route, and the static
  paint exists for the first-time (or signed-out) arrival. It is a client-side guess on
  purpose: the server knows exactly who is signed in, but varying `GET /` on the session
  cookie would put a per-visitor answer behind an edge cache keyed without it (see "The
  edge" above), and a wrong guess costs only one plain paint. Signing out clears the
  stamp (`splash.ts`'s `clearVisitStamp`, called from Settings' sign-out and the demo
  Exhibit Hall's "leave anonymously" flow) rather than leaving a stale claim in place —
  the whole point of the heuristic is guessing "has a session," and a signed-out browser
  no longer does. `web/src/prepaint.test.ts` is the drift guard for the script/style
  pairing itself: the two halves live in different files and neither does anything alone.
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
   or accept the break knowingly. Any such deliberate robot change — and any change to
   `ANALYZE_K`/`MOMENT_FLOOR`/`gradeFromDeficit` or stage-3 scoring in `server/src/analyze.ts`
   — must also bump `ANALYZE_VERSION` there: a cached analysis computed against different
   robots is a stale accusation, and the version is what forces the recompute. Laydown claims are a legitimate, *expected* source of fixture diffs even without
   touching robot behavior: once a board becomes DD-determined, its tail switches from the
   fixture's "first legal card" human strategy to `chooseCard`'s DD-optimal play, which can
   reorder (not rescore) the end of `plays`. Still eyeball the diff — confirm it's exactly that
   reordering and the score is unchanged — before accepting a new fixture.
   **The open question that used to sit under claims is now closed for new tournaments —
   and closing it is what made "Settled tricks" a settable preference.** The DD half of the
   gate is a TRUE-DD judgment (`solveFutureTricks` sees all
   four hands and assumes best play by everyone) and `resolveClaim` plays the tail true-DD at
   every difficulty — but at beginner and intermediate the robots would have played that tail
   through `chooseCardSampled`, i.e. fallibly. So a DD-settled position is only settled
   against a perfect opponent, and claiming on that alone quietly upgraded the robots for the
   rest of the hand, deleting whatever the human would have gained from an endgame mistake;
   the tier calibration, measured over full play, never saw those tails. A per-user "don't
   claim for me" toggle was rejected as the fix — it would hand two players on the identical
   board different robots because of a checkbox, and feed that into matchpoints and Elo — and
   the fix that shipped is not that: the rule is per TOURNAMENT
   (`tournaments.claim_rule`), so everyone on a board still faces the same gate.
   `'pessimistic'` requires the position be outcome-invariant under every legal card by all
   four seats, which dissolves the question rather than answering it — if no tail can change
   the score, the tier of whoever plays that tail cannot matter either. `'optimistic'`
   tournaments (every one that predates the migration) keep the old gate and the old caveat,
   permanently and by design.
   The per-user toggle then became safe, and shipped as "Settled tricks"
   (`users.auto_claim`) — but ONLY on `'pessimistic'` tournaments, where opting out provably
   cannot move a score. On `'optimistic'` ones the original objection is still live word for
   word, so those boards claim for everyone and the preference is ignored. If you ever find
   yourself relaxing that, re-read this paragraph: it is the same checkbox, and it would
   have the same effect. Changing any of this — the rule resolution, `CLAIM_NODE_BUDGET`,
   the fast paths or the move ordering in `packages/ai/src/claim.ts` — is a deliberate robot
   change under this invariant. Both golden traces
   (`server/test/fixtures/robot-trace.json` and `robot-trace-optimistic.json`, one per rule)
   guard it; regenerate with `node tools/gen_trace_fixture.mjs`. Note the asymmetry when you
   read that diff: the optimistic fixture should never move, while the pessimistic one can
   legitimately change SCORE and not just tail ordering, since it hands decisions back to a
   "human" that always plays its first legal card.
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

A sibling script, `scripts/placement_trace.mjs`, is here for the same reason: it execs the
same read-only query shape on the same machine, to capture the placement-demand trace
`tools/calibrate_placement.mjs` replays (see "Tuning placement" above). It selects no names,
handles or addresses — player ids become dense indices and timestamps become offsets — but
its output is still production behaviour and goes to the scratchpad, never the repo. It is
deliberately NOT covered by `.claude/settings.json`'s allowance, which names
`player_report.mjs` specifically: a second production exec should prompt.

A second sibling, `scripts/analyze_trace.mjs`, captures the finished-board trace `tools/
calibrate_moment_floor.mjs` replays (see "Tuning Analyze's moment floor" above) — same shape
again: read-only, fixed SELECT, output to the scratchpad only. It selects no names, handles,
emails or even user ids (unlike `placement_trace.mjs`'s dense player indices, nothing here
needs to survive who played) — just a board's own deal, calls, plays and its real field's
scores. Also deliberately NOT covered by the `autoMode` allowance, for the same reason.

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

`.claude/settings.json`'s `permissions`/`autoMode` blocks exist for exactly one reason: the
weekly player-outreach routine (`.claude/skills/player-outreach/`) fires into a fresh,
non-interactive session, and a session that can't answer a permission prompt simply stalls at
it. Every rule in those two blocks is scoped to that workflow. They are checked in so the
routine behaves identically for anyone who runs it, rather than depending on one person's local
approvals. (The file briefly also carried `extraKnownMarketplaces`/`enabledPlugins` blocks
registering two Claude Code plugin marketplaces for contributors — unrelated to outreach
permissions, and since replaced by individually-installed skills; see the `.claude` repo-map
entry above and each PR — #186/#187 added them, a later PR removed them.)

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

## Owning a change end to end

`.claude/skills/own-the-fix/` is the workflow skill behind `/own-the-fix`: describe a small
change once, and it implements it, opens the PR, waits for `claude-pr-review.yml`'s
automated review, triages and applies what's worth applying, runs a second independent pass
with the `code-review` skill, pushes the result, and drives CI to green — reporting back
exactly once, either "ready for merge" or "blocked on you". It deliberately never merges and
never enables auto-merge; that stays a human step.

Two repo facts it leans on, so change them together. **The automated review fires once, on
`opened`/`reopened`** (see the long comment in `claude-pr-review.yml` about why there is no
`workflow_dispatch`), which is why the skill insists on `npm run build && npm run typecheck
&& npm test` passing *before* the PR is opened — a PR opened broken spends its single review
on code about to be rewritten. And the same workflow's run #136 note is the skill's stated
worst case: an agent that says it will report back later and then ends its turn with nothing
scheduled. The skill's governing rule — never end a turn without either a wake-up armed or a
final report — exists for exactly that.

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
