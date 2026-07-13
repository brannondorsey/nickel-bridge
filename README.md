# Bridge Bot

A free, self-hostable web app for **learning SAYC bidding** and playing **four-deal duplicate
bridge tournaments** with friends — from your phone.

Each player plays the *same four deals* on their own schedule, seated South with a robot
partner against two robot opponents (like ACBL/BBO robot duplicates). Results are
matchpointed against your friends' results on identical deals, so the competition is about
judgment, not card luck.

## Learning features

- **Bid meanings before you bid** — tap any bid in the bidding box and a panel explains its
  SAYC meaning (point range, shape promise, whether it's conventional) *before* you commit.
  Robot bids are tappable too.
- **Bid grading** — every bid you make is scored ★★★/★★/★/✗ by the AI (see below), with the
  AI's preferred call shown when yours differs — like Tricky Bridge. A per-board and
  per-tournament *bidding accuracy* stat tracks your progress.
- **HCP counter** — your high-card points are always displayed (and dummy's, once revealed).
- **Full review** — after each board: everyone's contract/result on that deal, matchpoint
  percentages, and all four hands.

## Competition

- **Just-in-time tournaments** — hit *Play* and you're placed into the tournament with the
  most plays that you haven't played yet (so friends compare against each other), or a fresh
  one is created. Tournaments **never close** — the goal is maximum participation, and
  standings keep evolving as more friends play the same deals.
- **Matchpoints & percentiles** per board and overall, live standings.
- **Elo ratings, continuously re-ranked** — every completed tournament result triggers a
  deterministic full replay of the pairwise Elo history (start 1200, K=24), so a late
  finisher in an old tournament correctly re-ranks everyone. The Rankings page is the
  long-term leaderboard.

## The AI

- **Bidding** follows [*A Simple, Solid, and Reproducible Baseline for Bridge Bidding AI*
  (arXiv:2406.10306)](https://arxiv.org/abs/2406.10306). The pre-trained networks from the
  authors' [brl](https://github.com/harukaki/brl) repo (Apache-2.0) are converted to raw
  float32 and run in pure TypeScript (a 4×1024 MLP — no GPU, ~1 ms per bid). Two models ship:
  - `sl` (default): supervised imitation of WBridge5 playing SAYC — its choices line up
    with the SAYC explanations shown in the UI, which is what you want for learning.
  - `rl-fsp`: the stronger RL+fictitious-self-play model (+1.24 IMPs/board vs WBridge5).
    Set `AI_MODEL=rl-fsp` to use it; note its style can drift from textbook SAYC.

  The observation encoding is a bit-for-bit port of the [pgx](https://github.com/sotetsuk/pgx)
  `bridge_bidding` environment, verified by golden tests against the original JAX code.
- **Card play** is double-dummy optimal via Bo Haglund & Soren Hein's
  [DDS](https://github.com/dds-bridge/dds) compiled to WebAssembly (vendored from
  [bridge-dds](https://github.com/bookchris/bridge-dds-js), Apache-2.0).
- Robots are **deterministic** (argmax bidding, deterministic DD tie-breaks), so every player
  faces exactly the same robots on the same deals — that's what makes the duplicate
  comparison fair.

- **Bid grading** compares your call to the model's policy distribution over legal calls:
  top choice (or ≥60% of its probability) = Excellent, ≥20% = Good, ≥5% = Questionable,
  under = Poor.

## Development

```bash
npm install
npm run build                                   # core, ai, server, web
DEV_AUTH=1 npm run dev                          # server on :3000 with name-only login
npm run dev -w web                              # vite dev server on :5173 (proxies /api)
npm test                                        # unit + golden tests
node scripts/e2e.mjs http://localhost:3000      # end-to-end: two users, full tournament
```

`DEV_AUTH=1` enables `POST /auth/dev` name-only login so you can try everything without
Google credentials. Don't set it in production.

### Testing

- `npm test` — the whole unit/integration tier (~7s): core rules + scoring table, the SAYC
  explainer spec table (`packages/core/test/sayc.test.ts` — add a row when you add a
  convention), AI golden fixtures (bit-for-bit vs pgx), and in-process server suites
  (API behavior, hidden-hand redaction, JIT placement, Elo recompute, and the **robot
  determinism trace** — the fairness invariant of duplicate scoring).
- `npm run test:e2e` — one asserting Playwright smoke at phone viewport; boots the built
  server itself. Locally: `CHROMIUM_PATH=/path/to/chromium npm run test:e2e` to reuse an
  installed browser.
- `node scripts/e2e.mjs <url>` — smoke-test a *deployed* instance (needs `DEV_AUTH=1`).
- If you deliberately change robot behavior (model, encoding, card-play tie-breaks,
  dealing), regenerate the trace: `npm run build && node tools/gen_trace_fixture.mjs` —
  a surprising diff there means you were about to break comparability of live tournaments.
- The AI golden fixtures (`packages/ai/test/fixtures.json`) only need regenerating if the
  observation encoding or model weights change: `venv/bin/python tools/gen_fixtures.py …`
  — needs a Python venv with pinned jax (see the docstring in `tools/gen_fixtures.py`).
- CI (`.github/workflows/ci.yml`) runs build + typecheck + all suites + the smoke + a
  Docker image build on every push/PR.

## Google sign-in setup

1. [console.cloud.google.com](https://console.cloud.google.com) → create a project →
   *APIs & Services → OAuth consent screen*: External, fill in app name, publish.
2. *Credentials → Create credentials → OAuth client ID → Web application*:
   - Authorized redirect URI: `https://YOUR_DOMAIN/auth/google/callback`
3. Put the client ID/secret in your deployment's environment (below). Anyone with a Google
   account can sign up — share the URL with your friends.

## Deployment (pick one)

The whole app is one container: Node + SQLite + the AI. Backup = copy one file
(`/data/bridge.db`).

| Option | Cost | How |
| --- | --- | --- |
| **Fly.io** (hands-off) | ~$2–3/mo | see `fly.toml` header comments |
| **Any VPS** (Hetzner/DO…) | ~$4–5/mo | `cp .env.example .env`, fill it in, `docker compose up -d --build` (Caddy handles HTTPS) |
| **Oracle Cloud Always-Free VM** | $0 | same docker-compose on their free ARM VM |

### Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:3000` | public URL (OAuth redirects, secure cookies) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth |
| `DB_PATH` | `./data/bridge.db` | SQLite location |
| `PORT` | `3000` | listen port |
| `AI_MODEL` | `sl` | `sl` or `rl-fsp` |
| `DEV_AUTH` | off | `1` enables name-only dev login — never in production |

## Repo layout

```
packages/core   game rules: deals/PBN, auction, play, scoring, matchpoints, Elo, SAYC explainer
packages/ai     bidding network (TS inference + converted brl weights) and DDS WASM card play
server          Fastify API, SQLite, Google OAuth, tournament lifecycle
web             React SPA (mobile-first)
tools           one-time weight conversion + golden-fixture generation (Python)
scripts         e2e smoke test
```

## Licenses of bundled work

- Bidding model weights: [harukaki/brl](https://github.com/harukaki/brl), Apache-2.0
- Observation encoding derived from [sotetsuk/pgx](https://github.com/sotetsuk/pgx), Apache-2.0
- Double-dummy solver: [dds-bridge/dds](https://github.com/dds-bridge/dds) via
  [bridge-dds](https://github.com/bookchris/bridge-dds-js), Apache-2.0 (vendored in
  `packages/ai/vendor/bridge-dds`)
