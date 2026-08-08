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
`128/132 paths changed by this deploy` for a web-affecting deploy — or `130/132` if the same
deploy also changed `robots.txt`/`sitemap.xml`, which an edit to `seo.ts`'s route flags does. Conversely, a deploy that
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

### Result, recorded 2026-08-02 (15s resolution, post-fronting)

Production went orange 2026-07-30 ~20:30Z. Read on 2026-08-02 while both days were still at 15s:

| Day (UTC) | `nickel-bridge` up | episodes | mean episode | `nickel-bridge-demo` up |
| --- | --- | --- | --- | --- |
| 2026-07-31 | 9.27 h | 61 | 9.1 min | 3.35 h |
| 2026-08-01 | 14.58 h | 90 | 9.7 min | 1.31 h |

**The fronting did not measurably reduce production's machine time.** Mean 11.93 h/day and 75.5
episodes/day against a 13.05 h and 81 baseline — about 8% on hours and 7% on episodes, inside
the day-to-day spread of the baseline itself (11.85–14.25 h). Two days per side cannot resolve
a difference that small; treat it as "no effect detected", not as a measured 8% win.

The same read is also a live demonstration of why this table exists. Re-reading 2026-07-28/29 on
2026-08-02 returned them at 30s — 12.18 h/66 episodes and 14.68 h/72 — against the 11.85 h/77
and 14.25 h/85 recorded at the time. Hours drifted up, episodes down ~14%, purely from age. The
contemporaneous numbers are the real ones.

Demo's spike was **transient and self-inflicted**: two full e2e tournaments, repeated 131-URL
comparison sweeps, three forced 264-URL purges and extra deploys, all run against it while
debugging the purge on 07-30 and 07-31. By 08-01 it was back to 1.31 h/11 episodes,
indistinguishable from before it was fronted, so it was not evidence of fronting backfiring.

The 07-30 peak is not in the table above because it is at a different resolution, and mixing the
two is the mistake this whole section is about. From one `node scripts/fly-uptime.mjs
nickel-bridge-demo 7` run on 08-02, comparing **only its 30s rows against each other**:

| Day (UTC) | `nickel-bridge-demo` up | episodes | step |
| --- | --- | --- | --- |
| 2026-07-28 | 1.33 h | 11 | 30s |
| 2026-07-29 | 1.28 h | 11 | 30s |
| 2026-07-30 | 5.68 h | 36 | 30s |

A 4× spike on the day the debugging happened, against its own neighbours at matching step. Note
these 07-28/29 figures are the degraded 30s re-reads, not the 15s originals in the baseline table
— usable here precisely because every row being compared is equally degraded.

### Why it did not help, and what would

The cache is working exactly as designed — the four URLs the July log study identified as the
wakers are all HIT with long ages (`/` 15 h, `/robots.txt` and `/sitemap.xml` 36 h,
`/og-image.png` 67 h). The problem is that they are no longer what crawlers fetch. Every single
origin-reaching request observed on 2026-08-02 was a **glossary term page**, and a sampled 10 of
them showed 6 MISS / 4 HIT.

That is structural, not a misconfiguration. Prerendering created 127 URLs, an edge cache is
per-PoP, and a crawler visits each term page *once*. So each (page, PoP) pair is a first visit
that must reach the origin — up to ~1,650 unavoidable cold fills across ~13 PoPs per full crawl,
with no repeat traffic to amortize them. The discoverability work and the edge work pull against
each other: the long tail that makes the site findable is the part a per-PoP cache cannot help.

**Tiered Cache (Smart Topology) is the lever that fits this shape**, and it is free on all plans.
It collapses those ~13 independent PoP fills into one upper-tier fetch, which is precisely the
one-shot-per-PoP pattern above — worth roughly an order of magnitude more here than any TTL or
purge-frequency change. It is a ZONE-WIDE setting on a shared zone, so it stays a human decision
(see the note in `scripts/cloudflare.mjs`). Purge frequency is the second lever: with ~3
deploys/day plus the weekly `--force`, a term page cached at a PoP is usually dropped before a
second crawler ever reaches it.

### Tiered Cache enabled, 2026-08-05

Done: Tiered Cache → Smart Topology, enabled zone-wide on `brannon.online` (Caching → Tiered
Cache in the dashboard, or `PATCH /zones/:id/argo/tiered_caching`). Zone-wide is the only mode
Cloudflare offers — there is no per-hostname or Cache Rule scoping — so this reaches the ten
other proxied hostnames on the shared zone too. That is a deliberate exception to "nothing here
writes a zone-wide setting" (see CONTRIBUTING.md "The edge"): Tiered Cache is a strictly
cache-layer optimization with no plausible way to break another site's traffic, unlike the SSL
mode decision that section is really guarding against, so it was judged safe to flip as a human
decision outside `scripts/cloudflare.mjs`'s management — exactly as that script's docstring
already said this lever would have to be enabled.

**Why a region hint was needed.** Smart Topology normally picks the upper-tier Cloudflare data
centre nearest an origin by latency probing, and Cloudflare's own docs warn that origins behind
anycast or regional-unicast networking (their examples: AWS/GCP/Azure/Oracle) defeat that
probing, because every probe looks equally close. Fly's network is the same shape — a global
anycast address, SNI-routed internally to whichever machine is actually running — so without a
hint, Smart Topology's automatic pick could be wrong or unstable even though this app runs a
single machine in a single region (`fly.toml`'s `primary_region = 'ewr'`, Newark).

A region hint fixes this and is scoped **per origin IP**, not zone-wide, via
`PUT /zones/:id/origin/cloud_regions/:ip`:

```bash
ZONE_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones?name=brannon.online" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['id'])")

for IP in 66.241.125.167 "2a09:8280:1::14c:2c8e:0"; do   # nickel-bridge.fly.dev's A/AAAA
  curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/origin/cloud_regions/$IP" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
    --data "{\"origin_ip\": \"$IP\", \"vendor\": \"aws\", \"region\": \"us-east-1\"}"
done
```

`aws:us-east-1` was picked by checking the live catalogue
(`GET /zones/:id/origin/cloud_regions/supported_regions`) for which named region's
`upper_tier_colos` includes `EWR`. Confirmed **tied-optimal**, not merely a rough guess: both
`aws:us-east-1` and `oci:us-ashburn-1` map to the identical `["IAD", "EWR"]` set — the closest
any of the four supported vendors (none of which have a region literally in New Jersey) get to
this app's actual origin metro. Re-verify with:

```bash
curl -s "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/origin/cloud_regions" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | python3 -m json.tool
```

**What this changes about verification above.** Steps 2 and 6 in the sweep both lean on
`cf-cache-status` at the edge to prove the cache is doing its job. With tiering on, a lower-tier
PoP's own `MISS` no longer proves the origin was reached — the upper tier may have already had
it and answered without touching Fly. That's the mechanism working, not a false negative, but it
means those two steps are now only a **rule-matching** check (did a cache rule match this path
at all), not an **origin-wake** check. `scripts/fly-uptime.mjs` and the request log
(`server/src/logging.ts`) remain the only signal for whether Fly actually got woken — which the
"After" section below already treats as authoritative, so nothing there needed to change.

**No automated drift check exists for this.** `--plan`/`--apply`/`--check` manage only the Cache
Rules and Configuration Rules phases; the Tiered Cache toggle and the region hints sit in a
different part of the API (`/argo/tiered_caching`, `/origin/cloud_regions`) that this script
does not touch, so nothing here will notice if either gets flipped back off. If that becomes a
recurring problem, `--audit` reporting both read-only (the same pattern it already uses for the
zone's SSL default) would be the fix — not attempted here, since nothing has needed it yet.

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

### Tiered Cache result, recorded 2026-08-08

Tiered Cache went on 2026-08-05 (previous section). Read on 2026-08-08 per the recipe above —
but only **two** of the four rows came back at matching 15s resolution, not three:

```
app=nickel-bridge
day          up_h  episodes  mean_min  step
2026-08-04   8.84        52      10.2   30s
2026-08-05   6.38        39       9.8   30s
2026-08-06  11.69        64      11.0   15s
2026-08-07  11.02        69       9.6   15s

app=nickel-bridge-demo
day          up_h  episodes  mean_min  step
2026-08-04   1.47        12       7.3   30s
2026-08-05   1.52        11       8.3   30s
2026-08-06   1.06         9       7.1   15s
2026-08-07   0.75         6       7.5   15s
```

`2026-08-05` is the day the toggle flipped mid-day, so it's excluded from either side rather than
folded in as if it were clean pre- or post-tiering data — the same treatment `07-30` (the day
fronting itself went orange) got in the section above. `2026-08-08` itself isn't a complete UTC
day yet as of this read (`--recent`'s 24h window, ending 19:01Z, shows 11.63 h / 64 episodes at
15s — consistent with the two clean days below, for what it's worth, but not a full day and not
in the table). That leaves **2026-08-06 and 2026-08-07** as the only full days that are both
entirely post-tiering and at matching resolution — two, not the three the recipe above asks for,
and waiting longer would not have fixed it: `2026-08-05` is already 30s at only 3 days old, so a
later read would have pushed `2026-08-06` into 30s territory before `2026-08-08` ever became
usable, trading one non-comparable day for another rather than gaining a clean third. That also
sharpens the resolution-decay bound from the previous round, which only showed 15s holding at ≤2
days old and 30s by ≥4: this round pins the cutover to somewhere inside **2–3 days**. Worth
remembering for the next measurement: reading promptly at whatever cadence keeps accumulating
clean days beats waiting for one larger batch, since the resolution clock doesn't pause for a day
already in the past.

**Production**, mean of the two clean days: **11.36 h/day, 66.5 episodes/day** (11.0/9.6 min mean
episode). Against both priors on record:

| Comparison | Hours | Episodes |
| --- | --- | --- |
| vs. pre-fronting baseline (13.05 h, 81 ep) | −13.0% | −17.9% |
| vs. post-fronting/pre-tiering (11.93 h, 75.5 ep) | −4.8% | −11.9% |

Two days still can't resolve a small difference on their own — the limit every round here has
hit — but this round is distinguishable in a way the fronting-only round wasn't: fronting alone
(61, 90 episodes) straddled the pre-fronting baseline's own day-to-day range (77–85) on both
sides, which is why it was called "no effect detected." Fronting *plus* tiering (64, 69) sits
entirely below that range, on both days — a real shift, not just a mean moving. It still falls
short of what this section named as success above: "a drop from ~85 episodes to ~40," and the
6–8 h/day named as the expected landing place. 66.5 episodes and 11.36 h are roughly **82%** and
**87%** of pre-fronting — consistent with the −17.9%/−13.0% in the table above, not the ~50% the
stated target implies.

**Demo**, mean of the two clean days: **0.91 h/day, 7.5 episodes/day** — down from the 1.31 h /
11 episodes read on 08-01 (the one "steady", non-self-inflicted post-fronting demo day on
record) and from the 1.275 h pre-fronting mean: roughly **−30%** on both hours and episodes
against either comparison. That's larger than this doc's own prediction that demo "earns maybe
10–20%" — but demo's whole sample here is two days on a ~43-request/day app with a history of
large self-inflicted swings (the 5.68 h spike two rounds ago), so treat it as suggestive, not
confirmed.

**What's still open.** The mechanism this cache targets — glossary term pages, each a first-visit
MISS per PoP — hasn't been re-sampled this round the way the original diagnosis did
(`cf-cache-status` on a sample of live term pages, and the request-log identity check this
section recommends above). Production landing at 66.5 episodes rather than the ~40 named as the
target suggests either the topology hasn't fully consolidated yet, the region hint needs more
than 2–3 days to take full effect, or something besides glossary crawling is now the larger
remaining source — worth checking before concluding tiering has done all it's going to. Recorded
as **a real but partial improvement, not yet at the stated target**, with that question left open
rather than assumed away.

### What's still waking it, investigated 2026-08-08

Ran the check the section above left open: 16 real glossary slugs, each fetched twice against
`bridge.brannon.online`, `cf-cache-status` recorded on both, with `flyctl logs --app nickel-bridge
--json` tailing in parallel to see whether the pass-1 MISS actually reached origin.

Clean and consistent, but not the answer hoped for: every pass-1 was `MISS`, every pass-2 was
`HIT`, and **every single MISS correlated 1:1 with exactly one `GET /glossary/<slug>` line in the
app's own request log** — sixteen probes, sixteen origin hits, zero absorbed upstream of Fly.
From this vantage point, tiering bought nothing for this traffic.

The reason turns out to be the vantage point itself, not the mechanism: all 32 probes landed on
the identical Cloudflare colo — `cf-ray` end in `-IAD` on every one, because this sandbox has one
fixed network egress point. IAD is not an arbitrary lower-tier PoP here: it's one of the two
colos (`[IAD, EWR]`) the `aws:us-east-1` region hint set two rounds ago designates as this
origin's **upper tier**. A MISS at the upper tier was always going to reach origin, with or
without Tiered Cache — there's no higher tier above it to check. So this test could only ever
prove the null result it found; the actual consolidation, if it's happening, shows up in what
OTHER (non-upper-tier) PoPs do on a miss, which a single fixed vantage point structurally cannot
observe. Re-running this from several distinct regions would settle it; nothing available here
can reach more than one.

That reframes what "success" should even look like. Tiered Cache's ceiling was never *zero*
origin hits for glossary content — the upper tier itself still takes exactly one hit per page
**per purge cycle**, from whichever PoP reaches it first, and a purge clears the upper tier same
as everywhere else. Checked the actual deploy history for the two clean measurement days:

```
v124  2026-08-06T00:33:15Z  complete
v125  2026-08-06T01:05:21Z  complete
v126  2026-08-07T00:12:57Z  complete
v127  2026-08-07T22:07:04Z  complete
```

Four deploys, each a full-glossary purge (`purgeUrls()` — see "The edge" in CONTRIBUTING.md) —
close to the "~3 deploys/day" this doc has cited from the start, and each one re-opens the
one-hit-per-page floor across every PoP tier at once. That points at the lever PR #132 already
named second — purge frequency — as the more likely place left to gain, rather than at Tiered
Cache being incompletely effective: the mechanism did exactly what it could from what's directly
observable, and 66.5 vs. a ~40 target is plausibly that purge-driven floor rather than a sign
something's wrong.

Not settled by this round: whether episodes cluster in the hours right after each purge (the
per-day episode counts from `fly-uptime.mjs` don't carry sub-day timing — a narrower Prometheus
window around a known deploy timestamp would show it), and the cross-PoP question above. Recorded
as a sharpened hypothesis, not a closed case.

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
