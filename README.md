# Nickel Bridge

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
- **The Glossary** — a top-level, tappable bridge dictionary: ~124 curated terms with
  themes and search, the full Wikipedia glossary one toggle deeper, and every term
  mentioned in bid meanings, grades, or the toll receipt deep-links to its definition
  sheet in place.
- **Full review** — after each board: everyone's contract/result on that deal, matchpoint
  percentages, and all four hands.

## Competition

- **Just-in-time tournaments** — hit *Play* and you're placed into the most comparison-rich
  recent tournament you haven't played yet (popularity × recency scoring, with a grace
  window that funnels the first few players onto freshly created deals), or a fresh one is
  created — see [TOURNAMENT-SELECTION.md](TOURNAMENT-SELECTION.md) for the full design.
  Tournaments **never close** — the goal is maximum participation, and standings keep
  evolving as more friends play the same deals.
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

  Either way, robot bids pass through a SAYC guardrail: any bid that would break the
  machine-checkable hand requirements of its own SAYC meaning (a weak two on a five-card
  suit, an 11-HCP one-of-a-major opening) is excluded before the argmax, so the robots
  never make a bid the in-app explanation would contradict. Conventions the explainer
  can't hand-check (Stayman, transfers, Blackwood…) are untouched. See
  `docs/rule-based-bidding.md` for the design space beyond this guardrail.

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

New contributor (or AI agent)? Start with [CONTRIBUTING.md](CONTRIBUTING.md) — it maps the
codebase, the dev workflow, and the invariants (robot determinism!) you must not break.

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

- `npm test` — the whole unit/integration tier (~10s): core rules + scoring table, the SAYC
  explainer spec table (`packages/core/test/sayc.test.ts` — add a row when you add a
  convention), AI golden fixtures (bit-for-bit vs pgx), in-process server suites
  (API behavior, hidden-hand redaction, JIT placement, Elo recompute, and the **robot
  determinism trace** — the fairness invariant of duplicate scoring), and the web suite
  (jsdom + Testing Library: design-system components, every screen, both hand-flip
  orientations).
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
| **Fly.io** (hands-off, CI-automated) | ~$2–3/mo | see below |
| **Any VPS** (Hetzner/DO…) | ~$4–5/mo | `cp .env.example .env`, fill it in, `docker compose up -d --build` (Caddy handles HTTPS) |
| **Oracle Cloud Always-Free VM** | $0 | same docker-compose on their free ARM VM |

### Fly.io: automated preview + production deploys

CI (`.github/workflows/ci.yml`) deploys automatically once CI passes:

- **Every open PR** gets its own live preview app at `https://nickel-bridge-pr-<number>.fly.dev`,
  deployed on every push to the PR and linked in a PR comment. Preview apps run with
  `DEV_AUTH=1` (name-only login, no Google account needed) instead of real Google OAuth,
  since OAuth needs a redirect URI registered in advance and preview URLs are per-PR.
  They also run with `DEMO=1`: the PR comment's `/demo` link opens a scenario gallery,
  already signed in, that jumps straight into prepared game states for click-testing, with
  seeded demo data behind it (see CONTRIBUTING.md "Demo mode"). Neither flag is ever set on
  the production app — the production deploy job refuses to run if they are.
  `.github/workflows/pr-preview-teardown.yml` destroys the app (and its volume) when the PR
  closes, so preview cost never outlives the PR.
- **Every push to `main`** deploys straight to the production app (`nickel-bridge`), no manual
  approval step.
- **Every push to `main` also redeploys the permanent demo app** (`nickel-bridge-demo`,
  https://demo.bridge.brannon.online) — same `DEMO=1`/`DEV_AUTH=1` shape as previews, but at a
  stable URL that never gets torn down. It exists as a canonical target for automation (e.g.
  pointing an AI agent at the app to explore it) and occasional human click-testing, unlike
  per-PR preview URLs that die when the PR closes. Visit `/demo` to be signed in as the
  Inspector with no login, or `POST /api/demo/reset` to restore pristine seeded state. It has
  its own volume/database and never touches production data.

All three deploy jobs share one `fly.toml` — the `app = 'nickel-bridge'` line in it is only a default for
local/manual use; CI always passes `--app <name>` explicitly. Fly bills the always-on parts
(machines) near-zero when idle (`auto_stop_machines`/`min_machines_running = 0` in `fly.toml`),
so the main cost driver of adding previews is one small volume per currently-open PR — check
Fly's own pricing page for current per-GB rates.

**One-time setup** (only needs doing once, by whoever owns the Fly account — not repeated per
deploy).

1. Create a Fly.io account and install `flyctl` (`curl -L https://fly.io/install.sh | sh`).
2. `fly auth login`.
3. Confirm `nickel-bridge` is available as an app name (Fly app names are global) — pick
   another name and update `fly.toml` + the two workflow files if not.
4. Provision the production app once:
   ```
   fly apps create nickel-bridge
   fly volumes create data --app nickel-bridge --region ewr --size 5
   ```
   `fly.toml` also configures auto-extend (`auto_extend_size_threshold`/`_increment`/`_limit`),
   so the volume grows itself in 1GB steps once past 80% full, up to a 20GB cap — no manual
   `fly volumes extend` needed unless you outgrow that.
5. Mint an **org-scoped** token and add it as a GitHub Actions repository secret named
   `FLY_API_TOKEN` (Settings → Secrets and variables → Actions):
   ```
   fly tokens create org
   ```
   Use an org token, not a single-app `fly tokens create deploy --app <name>` token — CI
   creates a brand-new Fly app per open PR (`nickel-bridge-pr-<number>`), which an app-scoped
   token isn't allowed to do (it can only manage the one app it was minted for).
6. Point the production domain at the app: `fly certs add bridge.brannon.online --app
   nickel-bridge`, add a **DNS-only** (unproxied) CNAME `bridge → nickel-bridge.fly.dev` at
   the DNS host, and wait for `fly certs check bridge.brannon.online --app nickel-bridge` to
   go green. (Fly terminates TLS itself; a proxied/orange-cloud Cloudflare record breaks cert
   issuance.)
7. Register `https://bridge.brannon.online/auth/google/callback` as an authorized redirect URI
   (see "Google sign-in setup" above), then set the production app's real secrets — **only**
   on the production app, never on a preview app:
   ```
   fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... BASE_URL=https://bridge.brannon.online --app nickel-bridge
   ```
8. Point the demo domain at the demo app. Unlike production, there is no manual app/volume/
   secrets creation here — the `deploy-demo` CI job self-provisions all of that on the first
   push to `main` (and the app is reachable at `https://nickel-bridge-demo.fly.dev` right
   away). After that first deploy, run `fly certs add demo.bridge.brannon.online --app
   nickel-bridge-demo`, add a **DNS-only** (unproxied) CNAME `demo.bridge →
   nickel-bridge-demo.fly.dev`, and wait for `fly certs check demo.bridge.brannon.online
   --app nickel-bridge-demo` to go green.

Once `FLY_API_TOKEN` is set, the very next PR and the next merge to `main` will deploy
automatically — there's no separate manual first deploy to do.

### Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:3000` | public URL (OAuth redirects, secure cookies) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth |
| `DB_PATH` | `./data/bridge.db` | SQLite location |
| `PORT` | `3000` | listen port |
| `AI_MODEL` | `sl` | `sl` or `rl-fsp` |
| `DEV_AUTH` | off | `1` enables name-only dev login (previews + the demo app) — never on the production app |
| `DEMO` | off | `1` enables the demo-mode gallery + seeding (previews + the demo app) — never on the production app |

## Repo layout

```
packages/core   game rules: deals/PBN, auction, play, scoring, matchpoints, Elo, SAYC explainer
packages/ai     bidding network (TS inference + converted brl weights) and DDS WASM card play
server          Fastify API, SQLite, Google OAuth, tournament lifecycle
web             React SPA (mobile-first) — redesign brief in docs/design-brief.md
tools           one-time weight conversion + golden-fixture generation (Python)
scripts         e2e smoke test
```

## Licenses of bundled work

- Bidding model weights: [harukaki/brl](https://github.com/harukaki/brl), Apache-2.0
- Glossary definitions adapted from Wikipedia's
  [*Glossary of contract bridge terms*](https://en.wikipedia.org/wiki/Glossary_of_contract_bridge_terms),
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) — our adapted text
  (`web/src/glossary/`) is shared under the same license
- Observation encoding derived from [sotetsuk/pgx](https://github.com/sotetsuk/pgx), Apache-2.0
- Double-dummy solver: [dds-bridge/dds](https://github.com/dds-bridge/dds) via
  [bridge-dds](https://github.com/bookchris/bridge-dds-js), Apache-2.0 (vendored in
  `packages/ai/vendor/bridge-dds`)
