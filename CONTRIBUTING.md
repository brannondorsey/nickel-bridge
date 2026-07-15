# Contributing to Nickel Bridge

This guide is the technical map of the codebase for contributors — human or AI. The
[README](README.md) covers what the app is, its features, and how to deploy it; this file
covers how the code is organized, how to work on it, and which invariants you must not break.

> **Note for AI agents:** this file is symlinked as `.claude/CLAUDE.md`, so Claude Code loads
> it automatically as project memory. Trust it as a starting point, verify against the code
> when something is load-bearing, and [keep it up to date](#keeping-this-guide-up-to-date).

## Tech stack

- **TypeScript** everywhere (`strict: true`, `module`/`moduleResolution: NodeNext` —
  see `tsconfig.base.json`). **Node >= 22** required.
- **npm workspaces** monorepo: `packages/*`, `server`, `web`.
- **Server:** Fastify 5, `better-sqlite3` (synchronous SQLite), cookie sessions, Google OAuth.
- **Web:** React 18 + `react-router-dom` 6, built with Vite 5. No chart library — sparklines
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
                machine-readable `req` constraints, feeds bid grading), types.ts,
                barrel in index.ts
packages/ai     model.ts (loads models/{sl,rl-fsp}.{json,bin}, 4×1024 MLP → 38 logits),
                encode.ts (bit-for-bit port of pgx bridge_bidding observation encoding),
                bidder.ts (chooseCall argmax + bid grading: model probability ratio,
                floored at 'good' when core's advisor confirms the call is a SAYC
                convention the hand satisfies), play-ai.ts (DD-optimal card
                play via vendor/bridge-dds WASM)
server          index.ts (entry) → app.ts (buildApp(): all routes, serves web/dist),
                auth.ts (Google OAuth + DEV_AUTH dev login), db.ts (schema DDL, WAL),
                game.ts (loadBoard/submitCall/submitPlay/advanceRobots/boardView),
                tournaments.ts (JIT placement, standings, recomputeElo), stats.ts
web             main.tsx → App.tsx (router + MeContext auth + splash gating + TabBar),
                api.ts (typed API client), splash.ts (nb:lastVisit returning-visitor gate),
                pages/ (Board.tsx is the gameplay UI; sign-out lives on the Stats page),
                components/ds/ (design-system pieces) + components/game/ (auction, bid box,
                fans, trick area, deal diagram, toll-receipt score breakdown),
                src/test/ (fixtures + apiMock pattern),
                style.css (all styling — token blocks ported from the design prototype)
tools           offline Python weight conversion + golden-fixture generation;
                gen_trace_fixture.mjs regenerates the robot determinism trace;
                policy_probe.mjs prints the model's policy for any hand + auction
                (build first: `node tools/policy_probe.mjs "K98.QT95.AQJT5.7" --calls "1H P"`)
scripts         e2e.mjs (full two-user tournament against a running instance), ui-check.mjs
e2e             smoke.spec.ts — Playwright smoke at phone viewport (390×844)
docs            design-brief.md — requirements spec for the visual redesign
.claude         CLAUDE.md symlink (→ this file) + skills/nickel-bridge-design/, the
                design-system skill — see "Design system" below
```

## Development workflow

```bash
npm install
npm run build            # builds core → ai → server → web, in that order (order matters)
DEV_AUTH=1 npm run dev   # server on :3000 with name-only login (no Google creds needed)
npm run dev -w web       # Vite dev server on :5173, proxies /api and /auth to :3000
```

Checks — run all three before pushing; CI runs exactly these plus the Playwright smoke and a
Docker build (`.github/workflows/ci.yml`, on pushes to `main` and all PRs). Once those pass,
CI also deploys: every open PR gets its own Fly.io preview app (destroyed on close by
`.github/workflows/pr-preview-teardown.yml`), and every push to `main` deploys to production —
see README.md "Deployment" for the one-time Fly setup and how preview auth (`DEV_AUTH`) works:

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
| `BASE_URL` | `http://localhost:3000` | public URL; OAuth redirect + secure-cookie flag (`auth.ts`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth (`auth.ts`) |
| `DEV_AUTH` | off | `1` enables `POST /auth/dev` name-only login (`auth.ts`) — **never in production** |
| `DB_PATH` | `./data/bridge.db` | SQLite file; dir auto-created (`db.ts`) |
| `AI_MODEL` | `sl` | `sl` (SAYC-faithful) or `rl-fsp` (stronger, drifts from SAYC) (`game.ts`) |
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
needed to know which side or how many tricks — see `claimAnnouncement` in `playAnim.ts`),
shows an announcement banner, fast-forwards through a separate `stageClaimSteps` staging
function (kept apart from `stagePlaySteps`, which assumes at most one trick boundary per
response — a claim can span many), then a terminal stamp before handing off to the normal
completion view. See invariant 1 below — claims change what `advanceRobots` records for a
human's untaken decisions, so they interact directly with the robot-trace fixture.

**Deployment shape:** one container. The built server statically serves `web/dist` and
falls back to `index.html` for non-`/api`/`/auth` routes. SQLite on a single volume means
**exactly one machine** — no horizontal scaling. On Fly.io this means every environment
(production, and each per-PR preview) is its own separate app with its own volume — `fly.toml`
is shared across all of them, with the app name always overridden per-environment via `--app`
in CI (see `.github/workflows/ci.yml`'s `deploy-preview`/`deploy-production` jobs).

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

**Elo is recomputed from scratch** every time a board completes: `recomputeElo` wipes
`elo_history`, resets everyone to 1200, and replays all tournaments **in tournament-id
order** (not timestamps). That's deliberate — a late finisher in an old tournament re-ranks
everyone — so don't "optimize" it into an incremental update without redesigning the model.

**Hand-flip subtlety:** the human sits South, but when North (the robot partner) declares,
the human plays the North hand — see `humanControls` and the `flipped` handling in
`game.ts`/`boardView` and the Board page. Touching seat/turn logic? Test both orientations.

**better-sqlite3 is synchronous:** DB calls are not awaited; prepared statements live as
module-level constants next to the functions that use them. Match that style.

## Invariants — do not break

1. **Robot determinism is the fairness invariant of the whole product.** Bidding is model
   argmax; card play is DD-optimal with a deterministic tie-break; deals derive from the
   tournament seed. Every player must face identical robots on identical deals or duplicate
   scoring is meaningless. The trace fixture `server/test/fixtures/robot-trace.json` guards
   this. If you *deliberately* change robot behavior (model, encoding, tie-breaks, dealing),
   regenerate it: `npm run build && node tools/gen_trace_fixture.mjs`. If that diff surprises
   you, you were about to silently break comparability of live tournaments — stop and figure
   out why. Laydown claims are a legitimate, *expected* source of fixture diffs even without
   touching robot behavior: once a board becomes DD-determined, its tail switches from the
   fixture's "first legal card" human strategy to `chooseCard`'s DD-optimal play, which can
   reorder (not rescore) the end of `plays`. Still eyeball the diff — confirm it's exactly that
   reordering and the score is unchanged — before accepting a new fixture.
2. **`packages/ai/src/encode.ts` is a bit-for-bit port** of the pgx `bridge_bidding`
   observation encoding, verified by golden tests against the original JAX output. Do not
   refactor it for style. Regenerating `packages/ai/test/fixtures.json` is only needed if the
   encoding or model weights change, and requires a Python venv with pinned jax — see the
   docstring in `tools/gen_fixtures.py`.
3. **New SAYC convention ⇒ new spec-table row** in `packages/core/test/sayc.test.ts`.
4. **`packages/core` stays dependency-free and I/O-free** — pure rules. The server imports
   it; the web bundle deliberately does not (it mirrors the few helpers it needs in
   `web/src/api.ts` and receives anything score-shaped pre-computed from the server).
5. **`DEV_AUTH=1` must never be set in production** — it's unauthenticated login.

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
