# Edge runbook

Operator's companion to `scripts/cloudflare.mjs`. The *design* — how the rules are derived from
`server/src/seo.ts`, why nothing session-scoped may be cached, why no zone-wide setting is ever
written — lives in [CONTRIBUTING.md](../CONTRIBUTING.md) "The edge". This file covers the three
things that design doesn't: what we changed and why, how to verify a fronted host end to end,
and how to tell whether the fronting actually bought anything.

## What we changed, and why

`fly.toml` runs `auto_stop_machines = 'suspend'` with `min_machines_running = 0`. One inbound
request wakes a dedicated `performance-1x` core and holds it for Fly's whole idle window
(~6–10 min observed, mean episode 9–10 min). So machine time is bought *per wake*, not per unit
of work, and a bare `GET /robots.txt` from a crawler costs the same as a real player's visit.

A day of instrumented logs (`server/src/logging.ts`, added for exactly this) showed the wakers
were bots, touching only `/robots.txt`, `/`, `/sitemap.xml` and `/og-image.png`. **`robots.txt`
cannot fix that, and the proof is worth remembering:** ClaudeBot fetched the demo app's
`robots.txt`, read `Disallow: /`, obeyed it, and left — and that one compliant request still
cost seven minutes of dedicated CPU, because a bot has to reach the origin to learn it is
unwelcome. Disallowing takes a visit from 127 requests to 1, never to 0.

Only something that answers those paths *without touching Fly* takes it to 0, hence Cloudflare
in front. `scripts/cloudflare.mjs` derives the rules from `SITE_ROUTES` so they cannot drift
from robots.txt and the sitemap: `spa: false` rows **bypass**, `indexed: true` rows plus the
unhashed static files are **cached**, `/assets/*` is cached for a year (hashed filenames), and
the crawler surface is cached for a month. Two constraints shape the rest, and both are
enforced in code rather than trusted:

- **Nothing session-scoped may be cached.** `boardView` redacts hidden hands per player, so a
  cached `/api` response is one player's view of the deal served to another. That's an
  information leak, not a stale page. The invariants probe the predicate (not the expression
  string) and run on every invocation including CI's `--plan`.
- **`brannon.online` is a shared zone.** Deploying a ruleset phase is a `PUT` that replaces
  that phase zone-wide, so every managed rule carries a `[nickel-bridge]` prefix and `--apply`
  refuses to write either phase if it finds a rule it doesn't own. The SSL mode the Fly origins
  need is set per-request by a Configuration Rule rather than by PATCHing the zone setting,
  which would reach ten other hostnames on origins this repo knows nothing about.

Demo was fronted first as the debugging surface, then production. Two operational details cost
real outages/rework getting here and are now asserted: a fronted host must sit **one label below
the apex** (free Universal SSL covers `brannon.online` and `*.brannon.online`, and a wildcard
matches one label — `demo.bridge.brannon.online` had no edge cert and failed the handshake,
which is why the host is `demo-bridge.brannon.online`), and Fly's default **TLS-ALPN** cert
validation breaks behind a proxy, so each host needs `fly certs setup` plus its
`_fly-ownership` TXT record to move validation to HTTP-01.

## Order of operations when fronting a host

`--apply` must land **before** the DNS record goes orange. The rules are inert while the record
is grey, so applying early is free; going orange first means requests hit the edge with the
zone's default SSL mode and no cache rules — which for our origins (`force_https = true`) is a
redirect loop, cacheable for the full TTL.

1. `fly certs setup <host> --app <app>`, add the `_fly-ownership` TXT record, confirm with
   `fly certs show <host> --app <app>` that `validation` includes `http-01`.
   `isAcme*Configured` is a **cache** — run `fly certs check <host>` to refresh it, or you'll
   read a stale answer.
2. Merge, and let `deploy-production` run `--apply` while the record is still grey.
3. Flip the record to orange.
4. Run the sweep below.

## Exhaustive verification of a fronted host

Everything here is read-only and safe to run against production. `HOST` is the fronted
hostname, `APP` its Fly app; the `.fly.dev` name is never proxied, so it is the origin oracle.

```bash
HOST=demo-bridge.brannon.online
APP=nickel-bridge-demo
ORIGIN=$APP.fly.dev
```

**1. TLS terminates at the edge and verifies.** A non-zero `ssl_verify_result`, or a `server:`
header that isn't `cloudflare`, means the record isn't proxied or the cert is wrong.

```bash
curl -sS -o /dev/null -w '%{http_code} ssl_verify=%{ssl_verify_result}\n' "https://$HOST/"
curl -sSI "https://$HOST/" | grep -Ei '^(server|cf-ray|cf-cache-status):'
```

**2. The crawler surface caches.** Fetch each twice. The first may be `MISS` (or `HIT`, if that
PoP is already warm); the **second must be `HIT`**. A second `MISS`, or `BYPASS`/`DYNAMIC`,
means the cache rule doesn't match — the usual cause is a query string, since the rule matches
only an empty query (`NO_QUERY`) so a `?utm_source=…` tail can never strand an unpurgeable
variant.

```bash
for p in /robots.txt /sitemap.xml /og-image.png /favicon.svg / /glossary /glossary/blocked-suit; do
  a=$(curl -sSI "https://$HOST$p" | grep -i '^cf-cache-status:' | tr -d '\r' | awk '{print $2}')
  b=$(curl -sSI "https://$HOST$p" | grep -i '^cf-cache-status:' | tr -d '\r' | awk '{print $2}')
  printf '%-28s %s -> %s\n' "$p" "${a:-none}" "${b:-none}"
done
```

Use a **real** glossary slug (`web/src/glossary/terms.ts` has ~125; `blocked-suit` is one).
An invented one 404s by design and looks like a defect.

**3. Nothing session-scoped caches.** All of these must report `DYNAMIC` (never `HIT`, never
even `MISS`, which would mean a cache rule matched and the response was merely uncacheable
today). This is the information-leak check; it is also asserted in code, so a disagreement here
means the live ruleset has drifted from the script — run `--check`.

```bash
for p in /api/me /api/leaderboard /api/activity /auth/google /demo; do
  printf '%-20s %s\n' "$p" \
    "$(curl -sSI "https://$HOST$p" | grep -i '^cf-cache-status:' | tr -d '\r' | awk '{print $2}')"
done
curl -sSI "https://$HOST/?utm_source=test" | grep -i '^cf-cache-status:'   # expect DYNAMIC
```

**4. The edge is serving origin truth, byte for byte.** Compare hashes, not lengths. A mismatch
on `/` after a deploy is the failure mode `--purge` exists to prevent, and it is worse than a
stale page: prerendered HTML embeds that build's hashed asset filenames, so a stale copy points
`<script src>` at a file the new build deleted.

```bash
for p in /robots.txt /sitemap.xml / /glossary/blocked-suit; do
  e=$(curl -sS "https://$HOST$p" | sha256sum | cut -c1-16)
  o=$(curl -sS "https://$ORIGIN$p" | sha256sum | cut -c1-16)
  [ "$e" = "$o" ] && printf '%-28s same %s\n' "$p" "$e" || printf '%-28s DIFFER edge=%s origin=%s\n' "$p" "$e" "$o"
done
```

On a `DEMO=1`/`DEV_AUTH=1` host also confirm the throwaway-origin guard survives the edge —
`curl -sSI "https://$HOST/" | grep -i x-robots-tag` must show `noindex, nofollow`. Caching an
`X-Robots-Tag` is fine; losing it would let a wiped database into the index.

**5. The app still works through the proxy.** Headers alone won't catch a broken session
cookie or a redirect loop.

```bash
curl -sS -c /tmp/jar -o /dev/null -w '%{http_code} %{redirect_url}\n' "https://$HOST/demo"  # 302
curl -sS -b /tmp/jar "https://$HOST/api/me"                                                # a session
```

Then do it by hand, in a browser: sign in, play a board through bidding and play, watch a trick
animate and a receipt render. Sign-in is the one path that touches cookies, `BASE_URL`, and the
OAuth redirect all at once, and it is not exercised by any of the above.

**6. The script agrees with the live zone.**

```bash
node scripts/cloudflare.mjs --plan                  # no token needed; invariants only
node scripts/cloudflare.mjs --check                 # fails on drift, names foreign rules
node scripts/cloudflare.mjs --audit --host=$HOST     # cert expiry, validation methods, cache health
```

`--audit` needs `FLY_API_TOKEN` as well as `CLOUDFLARE_API_TOKEN`. It checks *outcomes* — days
to expiry, `validationErrors`, and the one combination that is definitely broken (proxied with
TLS-ALPN as the only configured validation method) — deliberately not "is DNS-01 configured",
which is the method Fly says collides with Cloudflare's Universal SSL records.

**7. Purge correctness, across a real deploy.** The only check that exercises the purge, and
the only one that can catch the expensive failure. Capture the asset hash the edge is serving,
push a web-affecting change to `main`, wait for `deploy-production`, then re-read it:

```bash
curl -sS "https://$HOST/" | grep -o '/assets/[^"]*\.js'
# ...deploy...
curl -sS "https://$HOST/" | grep -o '/assets/[^"]*\.js'
curl -sS -o /dev/null -w '%{http_code}\n' "https://$HOST$(curl -sS "https://$HOST/" | grep -o '/assets/[^"]*\.js' | head -1)"
```

The filename must change, and it must 200. Do the same for one glossary term page — those are
prerendered copies of the shell, so every deploy invalidates all ~125 of them, which is why
`purgeUrls()` enumerates them from `terms.ts`. In the CI log the purge step should say
`128/132 paths changed by this deploy` for a web-affecting deploy. Conversely, a deploy that
touches no web output should purge **nothing** — `0/132`, and it never calls the Cloudflare API.
Seeing that on a server-only deploy is the behaviour working, not a bug: a needless purge costs
one cold fill *per PoP*.

**Check this from more than one PoP.** The failure this replaced was invisible from a single
vantage point — Cloudflare's cache is per-PoP, and the old check sampled the edge from the CI
runner, which both mis-answered and self-repaired the one PoP it could see. `cf-ray`'s suffix
names the colo that answered you, so compare two:

```bash
curl -sSI "https://$HOST/glossary" | grep -iE 'cf-ray|^age'      # e.g. ...-IAD
curl -sSI --resolve "$HOST:443:$(dig +short $HOST | tail -1)" "https://$HOST/glossary" | grep -i cf-ray
```

Two PoPs disagreeing about `/glossary`'s `age` by hours, after a deploy that reported a purge,
is the signature of that bug returning. The asset filename embedded in the page is the sharper
tell: any page still naming a filename the origin no longer has is stale, and origin answers a
deleted asset with the SPA fallback as `text/html` at **200**, so check the content type, not
the status code.

## Proving the fix was meaningful

Judge **production on hours** and **demo on correctness**. What caching buys the two is very
different: production takes ~1,364 requests/day across ~13 PoPs, so repeat traffic per
(PoP, purge-window) is high; demo takes ~43/day across 4 dominant PoPs and redeploys ~3×/day,
so most crawl sessions there are the first at their PoP since the last purge and MISS anyway.
Expecting demo's hours to collapse is the wrong test — it earns maybe 10–20%.

Use `scripts/fly-uptime.mjs`, and read its header before trusting any number: Fly's Prometheus
punishes two obvious approaches. `count_over_time` is downsampled and under-reported by ~18×,
and even raw `metric[1d]` samples degrade **with age** (15s yesterday, 30s a few days back, 60s
a week back, with samples dropped outright, not merely thinned). The script prints the inferred
spacing per row; **rows of differing `step` are not comparable**. That is why the baseline below
is written down here rather than re-queried later.

### Baseline, recorded contemporaneously (15s resolution, pre-fronting)

| Day (UTC) | `nickel-bridge` up | episodes | mean episode | `nickel-bridge-demo` up |
| --- | --- | --- | --- | --- |
| 2026-07-28 | 11.85 h | 77 | 9.2 min | 1.30 h |
| 2026-07-29 | 14.25 h | 85 | 10.1 min | 1.25 h |

Rolling windows on 2026-07-30T02:54Z, hours after demo went orange and before production was
fronted: production 12.82 h of the last 24 h (53%, 83 episodes); demo 1.65 h (7%, 13 episodes).

### After

Wait for at least three full UTC days behind the proxy, then, while those days are still at 15s
resolution:

```bash
node scripts/fly-uptime.mjs nickel-bridge 4
node scripts/fly-uptime.mjs nickel-bridge-demo 4
node scripts/fly-uptime.mjs nickel-bridge --recent
```

Compare against the table above. **Episodes/day is the sharper signal than hours**: the edge
removes *wakes*, and each removed wake takes a whole idle window with it, so a drop from ~85
episodes to ~40 is the mechanism working even before the hours settle. Cross-check the identity
of what's left in the request log — `server/src/logging.ts` records `clientIp`, `clientIpSource`
and `userAgent`, and behind the proxy `clientIpSource` should read `cf-connecting-ip`:

```bash
fly logs --app nickel-bridge | grep -o '"userAgent":"[^"]*"' | sort | uniq -c | sort -rn | head
```

A success looks like the remaining wakes being **human** `/api` traffic plus one cold fill per
(PoP, purge-window), and bot user agents largely absent from the log. Do not expect near-zero
hours, and don't read that as failure:

- Human play is `/api`, permanently bypassed, and correctly so.
- Every purge costs one cold fill per PoP, and ~13 PoPs × ~3 deploys/day is a floor the TTL
  cannot lower. **Purge rate, not TTL, bounds the hit rate** — which is why `--purge` compares
  before dropping, and why raising the 30-day TTL further would buy nothing.
- Fly's health checks reach the machine from flyd directly, not through the proxy, so they
  neither wake it nor keep it awake — and they never appear as `clientIp` (a line with no
  `clientIp` came from flyd, not the internet).

Roughly 6–8 h/day on production would be the expected landing place. If hours *don't* move at
all, the question to ask is not "is the cache working" but "what is still waking it" — answer
it from the user agents and paths in the log, not from `cf-cache-status` on a hand-picked URL.

## If something looks wrong

| Symptom | First thing to check |
| --- | --- |
| TLS handshake fails right after going orange | Host depth (must be one label under the apex) and `fly certs show` |
| Endless redirects | SSL mode — the Configuration Rule must be setting Full (strict) for this host; `--check` |
| A path that should cache reports `DYNAMIC` | Query string (the rule requires an empty query), or the route's `indexed` flag in `seo.ts` |
| An `/api` path reports `HIT`/`MISS` | Stop. That is the leak invariant. Run `--check`, and if the live ruleset holds a rule the script doesn't own, `--apply` will have refused — a human has to reconcile it |
| `--apply` refuses to write | The zone holds a Cache or Configuration Rule without the `[nickel-bridge]` prefix. It names it. Move it into this script or out of these two phases; do not hand-merge |
| A page 404s on its assets after a deploy | A missed purge. `--purge --force` recovers it; then work out why the before/after origin comparison saw no change. If only *some* PoPs are affected, suspect that the purge is sampling the edge again rather than the origin |
| A page's assets return 200 but as `text/html` | Same thing seen from the other end — that is the SPA fallback answering for a file the build deleted. The page is stale, not the asset |
