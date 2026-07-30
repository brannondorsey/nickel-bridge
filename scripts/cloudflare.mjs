/**
 * The Cloudflare edge config for bridge.brannon.online, derived from the route table.
 *
 * WHY THIS EXISTS. With `auto_stop_machines = 'suspend'` and `min_machines_running = 0`,
 * any request that reaches Fly wakes a dedicated performance-1x core and holds it for the
 * whole idle window (~6-8 min observed). Measured in July 2026: production ran 20.1 h/day
 * (84%) and the permanent demo app — which has no human users at all — burned 1.8 h/day
 * purely on crawlers. Every bot seen in a day of instrumented logs (SemrushBot, YandexBot,
 * ClaudeBot, AggregatoreBot, link-preview fetchers) touched only `/robots.txt`, `/`,
 * `/sitemap.xml` or `/og-image.png`.
 *
 * robots.txt cannot fix that, and it is worth being precise about why: ClaudeBot fetched the
 * demo app's robots.txt, read `Disallow: /`, obeyed it perfectly, and left — and that single
 * compliant request still cost seven minutes of dedicated CPU, because a bot must reach the
 * origin to learn it is unwelcome. Disallowing a crawler cuts a session from 127 requests to
 * 1; it cannot cut it to 0. Only an edge that answers those paths without touching Fly can.
 *
 * WHY IT IS DERIVED. server/src/seo.ts is already the one table that robots.txt and the
 * sitemap come from. A hand-kept list of cache rules beside it would be a third copy with
 * the same failure mode the table was introduced to kill — and a worse one, because the
 * quiet failure here is caching something user-scoped. So the two rule sets come straight
 * out of SITE_ROUTES:
 *
 *   - bypass  = every `spa: false` row (the machine endpoints, /api/ and /auth/)
 *   - cached  = every `indexed: true` row (prerendered prose a crawler is invited to)
 *
 * Add an indexed route and it starts being cached; add an API route and it starts being
 * bypassed. Neither needs an edit here. Routes that are public but unindexed
 * (/leaderboard, /players/, /tour) are deliberately in neither set: they are live data, and
 * Cloudflare does not cache HTML unless a rule says to, so "no rule" is the correct answer.
 *
 * The invariants at the bottom of buildRules() run on EVERY invocation, including the
 * `--plan` that CI runs on every PR. A seo.ts edit that would put a user-scoped path in the
 * cache set fails the build rather than silently shipping a cache that serves one player's
 * redacted board to another.
 *
 * USAGE
 *   node scripts/cloudflare.mjs --plan     # print desired config, check invariants (no token)
 *   node scripts/cloudflare.mjs --apply    # reconcile Cloudflare to it (idempotent)
 *   node scripts/cloudflare.mjs --check    # fail if live config has drifted from desired
 *   node scripts/cloudflare.mjs --snapshot --out=f  # record origin bytes BEFORE deploying
 *   node scripts/cloudflare.mjs --purge --since=f   # drop what the deploy actually changed
 *   node scripts/cloudflare.mjs --purge --force     # ...or all of them, no comparison
 *   node scripts/cloudflare.mjs --audit    # cert + cache health; fails on anything actionable
 *
 * --purge and --audit take `--host=<one of SITES>` to act on a single deployment; without it
 * they cover every host. Deploys always pass it, since production and demo ship separately.
 *
 * RUNBOOK ORDERING. `--apply` must land BEFORE a record goes orange. The SSL mode our hosts
 * need comes from a Configuration Rule, so until that rule exists a proxied host falls back
 * to the zone default — and if that default is Flexible, fly.toml's `force_https = true`
 * makes an infinite redirect loop that the cache rule would then pin at the edge for the
 * full TTL. Merge first, let deploy-production run `--apply` while the record is still grey
 * (the rules are inert with no traffic matching them), and only then flip the cloud.
 *
 * KNOWN LIMITATION: query strings always reach the origin. Cloudflare's cache key includes
 * the query string and custom cache keys are Enterprise, so a cached `/?utm_source=…` could
 * never be purged (purge-by-URL is exact match; prefix purge is Enterprise too). Rather than
 * carry an unpurgeable tail, the cache rule matches only an empty query — see NO_QUERY. So
 * `/?anything` is a wake this does not suppress. That is the deliberate trade for being able
 * to hold a month-long edge TTL safely, and it costs little: the crawler surface is path-form.
 *
 * WORTH KNOWING: Cloudflare's cache is per-PoP, so the edge TTL doubles as the revalidation
 * interval for every data centre that sees traffic. Tiered Cache (Smart Topology, free on all
 * plans) would collapse those into one upper-tier fetch and cut origin wakes further — but it
 * is a ZONE-WIDE setting, so it is deliberately left for a human to enable rather than
 * reached for from here. See the note on zone settings above.
 *
 * ENV
 *   CLOUDFLARE_API_TOKEN  zone scoped, on brannon.online only:
 *                           Zone:Read            resolve the zone id
 *                           Cache Rules:Edit     the cache ruleset
 *                           Config Rules:Edit    the per-host SSL mode (see SSL_MODE)
 *                           Cache Purge:Purge    post-deploy purges
 *                           Zone Settings:Read   reporting the zone default; never written
 *                         Not needed for --plan.
 *   FLY_API_TOKEN         --audit only, to read the certificate's validation state.
 *   CF_ZONE_NAME          default 'brannon.online'
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Imported from source across the workspace boundary, exactly as web/scripts/prerender.mjs
// does it: seo.ts is dependency-free and Node/DOM-free so native type-stripping is enough.
const { SITE_ROUTES } = await import(resolve(root, 'server/src/seo.ts'));
// Same native type-stripping, same reason: the glossary term pages are prerendered from
// this list, so a purge built from anything else would drift from what the build emitted.
const { TERMS } = await import(resolve(root, 'web/src/glossary/terms.ts'));

const ZONE_NAME = process.env.CF_ZONE_NAME ?? 'brannon.online';
const API = 'https://api.cloudflare.com/client/v4';

/**
 * Every host fronted by this config, with the Fly app behind it.
 *
 * Both are fronted now. Demo went first and was verified end to end behind the proxy — TLS
 * clean, the crawler surface HITting, /api/me and /demo DYNAMIC, edge bytes identical to
 * origin — before production followed; adding production was literally uncommenting its row,
 * because the rules, invariants, purge list and audit are all derived per host.
 *
 * Their rules are identical rather than special-cased: the route table is the same in both
 * deployments (only robots.txt's *content* differs, via DEMO=1's throwaway-origin branch), so
 * a second rule shape would be a difference with no cause behind it.
 *
 * Note the asymmetry in what caching buys each one. Production takes ~1,364 requests/day
 * across 13 PoPs, so repeat traffic per (PoP, purge-window) is high and the cache pays off.
 * Demo takes ~43/day across 4 dominant PoPs and redeploys ~3x/day, so most crawl sessions are
 * the first at their PoP since the last purge and MISS anyway — it earns perhaps 10-20% there.
 * Demo is the debugging surface; production is where the machine time is.
 *
 * Everything here is scoped to these hosts, including the SSL mode — see SSL_MODE below for
 * why that is done with a Configuration Rule instead of the zone setting. `brannon.online`
 * carries ten other proxied hostnames belonging to unrelated projects, and nothing this
 * script does may reach them.
 */
const SITES = [
  { host: 'bridge.brannon.online', app: 'nickel-bridge' },
  { host: 'demo-bridge.brannon.online', app: 'nickel-bridge-demo' },
];
const HOSTS = SITES.map((s) => s.host);

/**
 * Every fronted host must be one Cloudflare can actually serve.
 *
 * Free Universal SSL is issued for `brannon.online` and `*.brannon.online`, and a wildcard
 * matches exactly one label — so the apex and any single-label subdomain are covered, and a
 * third-level name like `demo.bridge.brannon.online` is not. Proxying an uncovered name fails
 * the TLS handshake outright: the site is simply down, before any rule here is consulted. That
 * is not theoretical — it is what happened when demo was first flipped to orange, and it is
 * why demo now lives at `demo-bridge.brannon.online`.
 *
 * Covering deeper names needs Advanced Certificate Manager or Total TLS, both paid, and both
 * costing more than the machine time this whole exercise saves. So the constraint is asserted
 * rather than documented: CI's `--plan` fails on a host that could not be served.
 *
 * Called from inside the mode dispatch rather than at module top level, so a tripped assertion
 * gets the same `::error::` annotation as every other operational failure instead of an
 * uncaught stack trace.
 */
function assertFrontedHostsServable() {
  for (const { host } of SITES) {
    // The apex is zero labels below itself and is covered by Universal SSL directly.
    if (host === ZONE_NAME) continue;
    if (!host.endsWith(`.${ZONE_NAME}`)) {
      throw new Error(`INVARIANT: ${host} is not under the zone ${ZONE_NAME}.`);
    }
    const labels = host.slice(0, -(ZONE_NAME.length + 1)).split('.');
    if (labels.length !== 1) {
      throw new Error(
        `INVARIANT: ${host} is ${labels.length} labels below ${ZONE_NAME}; free Universal SSL ` +
          `covers only one, so proxying it would fail TLS. Use a single-label host ` +
          `(e.g. ${labels.join('-')}.${ZONE_NAME}) or buy Advanced Certificate Manager.`,
      );
    }
  }
}

/** Vite content-hashes everything here, so a new build means a new filename. */
const IMMUTABLE_PREFIX = '/assets/';
/**
 * Files no router row covers but every crawler asks for. `/robots.txt` and `/sitemap.xml`
 * are the two that matter most: they are the first thing a crawler fetches, so caching
 * them is what turns a crawl visit into zero origin requests.
 */
const STATIC_FILES = ['/robots.txt', '/sitemap.xml', '/og-image.png', '/favicon.svg'];

/**
 * Paths that must never cache but that SITE_ROUTES does not describe.
 *
 * `/demo` is registered by registerDemoRoutes, not the SPA router, so it has no row in the
 * table — and it is `GET /demo` → startSession() → Set-Cookie → 302, on the one app this
 * config currently fronts. Cloudflare would not cache it by default (extensionless, 302,
 * Set-Cookie), but "the default saves us" is exactly the reliance this script exists to
 * remove: a cached /demo hands one visitor's Inspector session to the next.
 */
const STATIC_BYPASS = ['/demo'];

const YEAR = 31_536_000;
const MONTH = 2_592_000;

/** A route path from the table as a matcher part: `/x/*` is a prefix, anything else exact. */
function asMatcher(path) {
  return path.endsWith('/*') ? { prefix: path.slice(0, -1) } : { exact: path };
}

/** Collect route paths into { exacts, prefixes } — the one shape both the expression and
 *  the predicate below are built from, so what we assert is what we ship. */
function matcherSet(paths) {
  const exacts = [];
  const prefixes = [];
  for (const p of paths) {
    const m = asMatcher(p);
    if (m.prefix) prefixes.push(m.prefix);
    else exacts.push(m.exact);
  }
  return { exacts, prefixes };
}

/** A concrete URL a route row stands for, so wildcard rows can be probed like exact ones. */
function samplePath(routePath) {
  return routePath.endsWith('/*') ? `${routePath.slice(0, -1)}probe` : routePath;
}

/** Does this matcher set cover a URL path? Mirrors seo.ts's `covers` semantics. */
function setMatches({ exacts, prefixes }, pathname) {
  return exacts.includes(pathname) || prefixes.some((p) => pathname.startsWith(p));
}

/**
 * Cloudflare Ruleset-engine expression for a matcher set, scoped to our hosts.
 *
 * The host clause is not decoration: the zone is `brannon.online`, so an unscoped rule would
 * silently apply to every other subdomain served from it.
 */
function expression({ exacts, prefixes }, extra) {
  const parts = [];
  if (exacts.length) {
    parts.push(`http.request.uri.path in {${exacts.map((e) => JSON.stringify(e)).join(' ')}}`);
  }
  for (const p of prefixes) parts.push(`starts_with(http.request.uri.path, ${JSON.stringify(p)})`);
  const hosts = `http.host in {${HOSTS.map((h) => JSON.stringify(h)).join(' ')}}`;
  return [`(${hosts})`, `(${parts.join(' or ')})`, ...(extra ? [extra] : [])].join(' and ');
}

/**
 * Cache only the bare path, never a query-string variant.
 *
 * Cloudflare's cache key includes the query string and custom cache keys are Enterprise, so
 * `/?utm_source=…` would otherwise be its own entry — and purge-by-URL is exact match, so
 * nothing could ever drop it (prefix purge is Enterprise too). Every prerendered page embeds
 * the build's hashed asset filenames, so a stale one serves `<script src>` pointing at an
 * asset the next deploy deleted. Cached-and-unpurgeable is therefore a page that breaks and
 * stays broken for the whole TTL, which is exactly what makes a long TTL unsafe.
 *
 * Excluding queries makes every cached entry a plain path, so purgeUrls() covers 100% of the
 * cache and the TTL below can be long. The cost is that `/?anything` always reaches origin —
 * but the crawler surface is path-form (the sitemap lists `/glossary/<slug>`), and the
 * observed query-string callers were one-off scrapers whose params vary per request, so they
 * would have missed the cache anyway.
 */
const NO_QUERY = 'http.request.uri.query eq ""';

/**
 * The desired cache ruleset. Rules are mutually exclusive by construction, so their order
 * carries no meaning — worth keeping that way, since Cloudflare resolves overlapping cache
 * rules by last-match-wins and that is an easy thing to get subtly wrong.
 */
export function buildRules() {
  const bypass = matcherSet([...SITE_ROUTES.filter((r) => !r.spa).map((r) => r.path), ...STATIC_BYPASS]);
  const cached = matcherSet([
    ...SITE_ROUTES.filter((r) => r.indexed).map((r) => r.path),
    ...STATIC_FILES,
  ]);
  const immutable = matcherSet([`${IMMUTABLE_PREFIX}*`]);

  // ---- invariants: these run on every invocation, including CI's --plan ----
  // Anything user-scoped reaching the cache set is an information leak, not a stale page:
  // boardView redacts hidden hands per player, so one cached response is another player's
  // view of the deal. Probe the predicate rather than trusting the expression string.
  const MUST_BYPASS = [
    '/api/me',
    '/api/activity',
    '/api/leaderboard',
    '/api/tournaments/29/boards/2',
    '/api/tournaments/29/boards/2/play',
    '/auth/google',
    '/auth/google/callback',
    '/auth/logout',
    '/demo',
  ];
  for (const p of MUST_BYPASS) {
    if (setMatches(cached, p) || setMatches(immutable, p)) {
      throw new Error(`INVARIANT: ${p} would be CACHED. Never cache a session-scoped path.`);
    }
    if (!setMatches(bypass, p)) {
      throw new Error(`INVARIANT: ${p} is not covered by the bypass rule.`);
    }
  }
  // Derived, not sampled: EVERY non-public row in the table must stay out of the cache set.
  // The hardcoded probes above are worth keeping for the paths whose shape matters, but on
  // their own they only cover routes that existed when they were written — adding
  // `{ path: '/settings', public: false, indexed: true }` slipped straight past them.
  for (const r of SITE_ROUTES) {
    if (r.public) continue;
    const sample = samplePath(r.path);
    if (setMatches(cached, sample)) {
      throw new Error(`INVARIANT: ${r.path} is not public but would be CACHED (probed as ${sample}).`);
    }
  }
  // The public-but-unindexed rows are live data, and must not be cached either.
  for (const p of ['/t/29/b/2', '/activity', '/scenarios', '/leaderboard', '/players/7']) {
    if (setMatches(cached, p)) throw new Error(`INVARIANT: ${p} would be CACHED but is not indexed prose.`);
  }
  // And the whole point: the crawler surface must actually be covered.
  for (const p of ['/', '/robots.txt', '/sitemap.xml', '/og-image.png', '/glossary', '/glossary/squeeze']) {
    if (!setMatches(cached, p)) throw new Error(`INVARIANT: ${p} is not cached — crawlers would still wake the machine.`);
  }

  return [
    {
      description: `${RULE_TAG} Never cache the private surface (derived from seo.ts spa:false)`,
      expression: expression(bypass),
      action: 'set_cache_settings',
      action_parameters: { cache: false },
    },
    {
      description: `${RULE_TAG} Content-hashed assets are immutable`,
      expression: expression(immutable),
      action: 'set_cache_settings',
      action_parameters: {
        cache: true,
        edge_ttl: { mode: 'override_origin', default: YEAR },
        browser_ttl: { mode: 'override_origin', default: YEAR },
      },
    },
    {
      description: `${RULE_TAG} Crawler-facing surface (derived from seo.ts indexed:true) — stops the wakes`,
      expression: expression(cached, NO_QUERY),
      action: 'set_cache_settings',
      action_parameters: {
        cache: true,
        edge_ttl: {
          mode: 'override_origin',
          // A month, not a day. Cloudflare's cache is per-PoP, so the TTL is also the
          // revalidation interval for EVERY data centre that sees a crawler — and the logs
          // show ~17 of them. At a day that is ~17 origin fetches daily from expiry alone,
          // each buying a ~7 min idle window: roughly 2 h/day, most of what this exists to
          // save. At a month it is ~17/month. Safe only because every cached entry is now a
          // bare path (see NO_QUERY) and every one of them is in purgeUrls(), so a deploy
          // invalidates the whole cache rather than leaving a long tail behind.
          default: MONTH,
          // /glossary/<unknown-slug> answers 404 and is covered by the same prefix. Those
          // URLs cannot be enumerated for purge, so a day-long 404 would outlive the typo
          // that caused it — and a newly added term would 404 at the edge until tomorrow.
          status_code_ttl: [{ status_code_range: { from: 400, to: 499 }, value: 300 }],
        },
        // Short on purpose: the edge TTL is what suppresses origin wakes, while a long
        // browser TTL would strand a deploy in someone's tab. Purge handles the edge.
        browser_ttl: { mode: 'override_origin', default: 300 },
      },
    },
  ];
}

/**
 * Every URL --purge drops: the cached HTML a deploy actually changes. Hashed /assets/* are
 * deliberately absent — a new build emits new filenames, so there is nothing stale to drop.
 *
 * The ~125 glossary term pages have to be enumerated rather than skipped, and the reason is
 * sharper than staleness. Each prerendered page is a copy of the built shell, so it embeds
 * that build's hashed asset filenames — which means EVERY deploy invalidates all of them,
 * and a term page left cached for its full day would be serving `<script src>` pointing at
 * an asset the new build deleted. Not a stale definition: a broken page. `SITE_ROUTES` has
 * no per-slug rows to expand (`/glossary/*` is one wildcard row), so the slugs come from
 * terms.ts — the same source the prerender builds those pages from, imported the same way.
 *
 * Scoped to one host by `--host=`, because production and the demo app deploy independently
 * and purging the other one's pages on every push would throw away good cache entries.
 */
export function purgeUrls(hosts = HOSTS) {
  const exact = SITE_ROUTES.filter((r) => r.indexed && !r.path.endsWith('/*')).map((r) => r.path);
  const terms = TERMS.map((t) => `/glossary/${t.slug}`);
  // STATIC_FILES are cached but unhashed, so a re-run of og-image.mjs (or a favicon edit)
  // would otherwise sit stale at the edge for a full day.
  const paths = [...new Set([...exact, ...terms, '/index.html', ...STATIC_FILES])];
  return hosts.flatMap((h) => paths.map((p) => `https://${h}${p}`));
}

/**
 * Cloudflare takes at most 30 URLs per purge call on Free/Pro/Business (500 on Enterprise),
 * so the list is chunked. Host-scoped purges land ~5 calls, comfortably inside the free
 * plan's 25-token burst; purging every host at once would be ~9 and is only ever a manual
 * operation, so a small delay between calls keeps it under the 5/minute refill too.
 */
const PURGE_BATCH = 30;

/** `--host=x` narrows host-scoped commands; absent means every host in SITES. */
function selectedHosts() {
  const arg = process.argv.find((a) => a.startsWith('--host='));
  if (!arg) return HOSTS;
  const host = arg.slice('--host='.length);
  if (!HOSTS.includes(host)) throw new Error(`--host=${host} is not one of: ${HOSTS.join(', ')}`);
  return [host];
}

// ---------------------------------------------------------------- API plumbing

function token() {
  const t = process.env.CLOUDFLARE_API_TOKEN;
  if (!t) throw new Error('CLOUDFLARE_API_TOKEN is not set');
  return t;
}

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const errs = (body.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ');
    throw new Error(`Cloudflare ${init.method ?? 'GET'} ${path} failed (${res.status}): ${errs || 'unknown'}`);
  }
  return body.result;
}

async function zoneId() {
  const zones = await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  if (!zones?.length) throw new Error(`zone ${ZONE_NAME} not found for this token`);
  return zones[0].id;
}

const CACHE_PHASE = 'http_request_cache_settings';
const CONFIG_PHASE = 'http_config_settings';

/**
 * Marker on every rule this script owns.
 *
 * Deploying a phase entrypoint is a PUT — it REPLACES the whole ruleset for that phase,
 * zone-wide. On a shared zone that is a foot-gun with no undo: brannon.online carries ten
 * other proxied hostnames, and a cache rule somebody added for one of them would be deleted
 * by our first --apply, silently and with no record of what it was. So every managed rule
 * carries this prefix, and putRuleset() refuses to write when it finds a rule that does not.
 */
const RULE_TAG = '[nickel-bridge]';

/**
 * Recursively sort object keys so two structurally identical objects stringify identically.
 *
 * Cloudflare returns `action_parameters` with its keys ALPHABETIZED, while we author them in
 * the order that reads best (`cache`, then `edge_ttl`, then `browser_ttl`). JSON.stringify is
 * key-order sensitive, so comparing the two reported drift on every single run even though
 * every value matched — `{browser_ttl, cache, edge_ttl}` vs `{cache, edge_ttl, browser_ttl}`,
 * and `{default, mode}` vs `{mode, default}` one level down. Arrays keep their order, which
 * matters: rule order is significant in a ruleset, and so is status_code_ttl's.
 */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  }
  return value;
}

/** Compare only the fields we manage, so Cloudflare's server-side additions aren't "drift". */
const shape = (r) =>
  canonical({
    description: r.description,
    expression: r.expression,
    action: r.action,
    action_parameters: r.action_parameters,
  });

/** Read a phase entrypoint's rules, treating "no such ruleset yet" as empty. */
async function liveRules(id, phase) {
  try {
    const rs = await cf(`/zones/${id}/rulesets/phases/${phase}/entrypoint`);
    return rs.rules ?? [];
  } catch {
    return [];
  }
}

/**
 * Refuse to touch a phase that holds rules this script does not own.
 *
 * The Rulesets API has no "merge" for an entrypoint: a PUT is the whole list. Refusing when
 * an untagged rule is present is the only way to keep that from quietly deleting a rule this
 * repo did not create. Adopting them instead would be worse — they would be reconciled away
 * on the next run, one deploy later and further from the cause.
 *
 * Run across EVERY phase before writing ANY of them. Checking each phase just before its own
 * write leaves a half-applied zone when the second one aborts, which is a worse state to
 * debug than either extreme.
 */
async function assertPhaseOwned(id, phase) {
  const foreign = (await liveRules(id, phase)).filter((r) => !(r.description ?? '').startsWith(RULE_TAG));
  if (!foreign.length) return;
  const list = foreign.map((r) => `    - ${r.description || '(no description)'}: ${r.expression}`).join('\n');
  throw new Error(
    `refusing to write the ${phase} ruleset: it holds ${foreign.length} rule(s) this script does not own.\n` +
      `  A PUT replaces the entire phase, so applying would delete them:\n${list}\n` +
      `  Move them into this script (tagged "${RULE_TAG}") or remove them by hand first.`,
  );
}

async function writeRuleset(id, phase, rules) {
  await cf(`/zones/${id}/rulesets/phases/${phase}/entrypoint`, {
    method: 'PUT',
    body: JSON.stringify({ rules }),
  });
}

// ---------------------------------------------------------------- commands

/**
 * SSL mode, scoped to our hosts by a Configuration Rule rather than set on the zone.
 *
 * `brannon.online` is a shared zone with ten other proxied hostnames on origins this repo
 * knows nothing about, and the zone's SSL mode is a single global switch — so PATCHing
 * `/settings/ssl` to reconcile one app would reach every one of them. Moving an origin that
 * only speaks HTTP to Full (strict) takes it down, and "we needed it for the bridge app" is
 * no comfort to whatever else broke.
 *
 * A Configuration Rule sets the same thing per-request (`set_config`, `http_config_settings`
 * phase, available on the Free plan with a 10-rule budget), so the zone default is left
 * exactly as found. Demo genuinely needs it: Flexible against fly.toml's `force_https = true`
 * is an infinite redirect loop, so this is the difference between a working site and an
 * outage — but it is now that difference for our hosts alone.
 *
 * `always_use_https` is deliberately NOT managed. It is zone-only with no per-host
 * equivalent, and it buys one saved redirect on plain-HTTP bot requests — not worth reaching
 * across a shared zone for. If it is ever wanted, a scoped Redirect Rule is the way.
 */
const SSL_MODE = 'strict';

export function buildConfigRules() {
  const hosts = `http.host in {${HOSTS.map((h) => JSON.stringify(h)).join(' ')}}`;
  return [
    {
      description: `${RULE_TAG} SSL mode for the bridge apps only — never the zone default`,
      expression: `(${hosts})`,
      action: 'set_config',
      action_parameters: { ssl: SSL_MODE },
    },
  ];
}

async function plan() {
  const rules = buildRules();
  const configRules = buildConfigRules();
  console.log(
    JSON.stringify({ zone: ZONE_NAME, hosts: HOSTS, configRules, rules, purge: purgeUrls() }, null, 2),
  );
  console.log(`\n✓ ${rules.length} cache rules + ${configRules.length} config rule derived from seo.ts`);
  console.log(`  for ${HOSTS.join(', ')}; all invariants hold. No zone-wide settings are touched.`);
}

async function apply() {
  const rules = buildRules();
  const configRules = buildConfigRules();
  const id = await zoneId();

  // Read-only, and reported rather than reconciled: this is a shared zone, so the default is
  // somebody else's to set. It only matters that it is not Flexible for OUR hosts, which the
  // config rule below guarantees regardless of what it says.
  const ssl = await cf(`/zones/${id}/settings/ssl`);
  console.log(`zone ssl default: ${ssl.value} (left as-is)`);

  // Preflight both phases before writing either — see assertPhaseOwned.
  for (const phase of [CONFIG_PHASE, CACHE_PHASE]) await assertPhaseOwned(id, phase);

  await writeRuleset(id, CONFIG_PHASE, configRules);
  console.log(`config rules: applied ${configRules.length} (ssl=${SSL_MODE} for ${HOSTS.join(', ')})`);

  await writeRuleset(id, CACHE_PHASE, rules);
  console.log(`cache rules: applied ${rules.length} for ${HOSTS.join(', ')}`);
  for (const r of rules) console.log(`  - ${r.description}`);
}

async function check() {
  const id = await zoneId();
  const problems = [];

  // Compare only the rules we own. Cloudflare returns server-side fields and may normalize
  // expressions after a PUT, so whole-list equality against a live zone is a promise this
  // cannot keep — and a permanently red weekly job is one nobody reads. Foreign rules are
  // reported separately rather than as "drift", because the fix for them is not --apply.
  for (const [phase, want] of [
    [CONFIG_PHASE, buildConfigRules()],
    [CACHE_PHASE, buildRules()],
  ]) {
    const live = await liveRules(id, phase);
    const foreign = live.filter((r) => !(r.description ?? '').startsWith(RULE_TAG));
    if (foreign.length) {
      problems.push(
        `${phase} holds ${foreign.length} rule(s) not owned by this script — --apply will refuse ` +
          `until they are moved in or removed: ${foreign.map((r) => r.description || '(untitled)').join(', ')}`,
      );
    }
    const ours = live.filter((r) => (r.description ?? '').startsWith(RULE_TAG)).map(shape);
    if (JSON.stringify(ours) !== JSON.stringify(want.map(shape))) {
      problems.push(`${phase}: our rules differ from the config derived from seo.ts`);
      console.log(`--- live (${phase}, ours only) ---\n` + JSON.stringify(ours, null, 2));
      console.log(`--- desired (${phase}) ---\n` + JSON.stringify(want.map(shape), null, 2));
    }
  }

  const ssl = await cf(`/zones/${id}/settings/ssl`);
  console.log(`zone ssl default: ${ssl.value} (not managed here — see SSL_MODE)`);

  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`);
    console.log('\nIf these are drift in our own rules: node scripts/cloudflare.mjs --apply');
    process.exitCode = 1;
    return;
  }
  console.log(`✓ Cloudflare cache + config rules match seo.ts for ${HOSTS.join(', ')}.`);
}

/**
 * The handful of URLs whose bytes decide the whole purge set.
 *
 * The prerendered pages are not independent: every one of them is a copy of the same built
 * `index.html` with its head span and `#root` swapped, so they all embed that build's
 * content-hashed `/assets/index-<hash>.js`. A build that changes anything the bundle touches
 * changes ALL of them at once, which is why sampling `/` answers for all ~127. `/glossary`
 * and two term pages are belt-and-braces for the one case `/` alone would miss — a change to
 * `server/src/seo.ts`'s per-route metadata, which the prerender reads but the bundle does not.
 *
 * The first and last slug are deterministic given terms.ts. If terms.ts changes shape the
 * sampled paths change with it, and a snapshot whose path set no longer matches is treated as
 * unusable — i.e. purge everything. That is the safe direction.
 */
export function samplePaths() {
  const slugs = [TERMS[0]?.slug, TERMS[TERMS.length - 1]?.slug].filter(Boolean);
  return ['/', '/glossary', ...slugs.map((s) => `/glossary/${s}`), ...STATIC_FILES];
}

/** Paths in the sample that stand in for the whole prerendered set. */
const isHtmlSample = (p) => !STATIC_FILES.includes(p);

/**
 * SHA-256 of what the ORIGIN currently serves for each sample path.
 *
 * Origin truth comes from `<app>.fly.dev`, which is never proxied. That is not merely
 * convenient, it is the correctness property: there is exactly one origin machine (SQLite on
 * a single volume — see CONTRIBUTING.md "Deployment shape"), so this reads the same bytes no
 * matter who asks or from where. The edge does not have that property, and an earlier version
 * of this script learned it the expensive way — see purge() below.
 *
 * Any non-200, unreadable body or thrown error yields `null` for that path, which callers
 * must treat as "unknown" and therefore "purge".
 */
async function originHashes(site, paths) {
  const { createHash } = await import('node:crypto');
  const out = {};
  await mapLimit(paths, 8, async (p) => {
    try {
      const res = await fetch(`https://${site.app}.fly.dev${p}`, {
        headers: { 'User-Agent': 'nickel-bridge-purge-check' },
      });
      out[p] = res.ok ? createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex') : null;
    } catch {
      out[p] = null;
    }
  });
  return out;
}

/**
 * `--snapshot` — record the origin's pre-deploy bytes so `--purge` can tell what this deploy
 * actually changed. Runs immediately BEFORE `flyctl deploy` in the same job.
 *
 * It costs one wake at most, and usually not even that: the deploy that follows a few seconds
 * later would have woken the machine anyway.
 */
async function snapshot() {
  const sites = SITES.filter((s) => selectedHosts().includes(s.host));
  const out = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
  if (!out) throw new Error('--snapshot needs --out=<file>');
  const paths = samplePaths();
  const data = {};
  for (const site of sites) data[site.host] = await originHashes(site, paths);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(out, JSON.stringify({ version: 1, paths, sites: data }, null, 2));
  const unknown = Object.values(data).flatMap((h) => Object.entries(h).filter(([, v]) => !v));
  console.log(`snapshot: ${paths.length} origin paths × ${sites.length} host(s) -> ${out}`);
  if (unknown.length) console.log(`  ${unknown.length} unreadable (those paths will purge unconditionally)`);
}

/** Run an async mapper over items with bounded concurrency. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
    }),
  );
  return out;
}

/**
 * Decide, from before/after ORIGIN bytes, which of this host's cached paths this deploy
 * changed. Returns null to mean "cannot tell — purge everything".
 */
export function changedPaths(site, before, allPaths, after, paths) {
  if (!before || before.version !== 1) return null;
  const prev = before.sites?.[site.host];
  if (!prev) return null;
  // A snapshot taken against a different sample set (terms.ts changed shape) cannot be
  // compared path-for-path, and guessing would be a silent under-purge.
  if (paths.length !== before.paths?.length || paths.some((p, i) => p !== before.paths[i])) return null;

  // The two halves are independent and BOTH must be collected: an HTML sample moving expands
  // to the whole prerendered set, while a static file moving purges just itself. Returning
  // the moment an HTML sample differs would drop every static file later in the array —
  // and since samplePaths() lists the HTML samples first, that meant a deploy which changed
  // both (editing seo.ts's route flags changes the prerendered pages AND the runtime-generated
  // robots.txt — the documented way to add an indexable route) purged the pages and left
  // robots.txt stale for the full month. Silent, and the exact failure this purge exists to
  // prevent.
  const changed = new Set();
  let htmlChanged = false;
  for (const p of paths) {
    const a = prev[p];
    const b = after[p];
    // An unreadable read on EITHER side is unknown, not unchanged.
    if (!a || !b || a !== b) {
      if (isHtmlSample(p)) htmlChanged = true;
      else changed.add(p);
    }
  }
  if (htmlChanged) for (const p of allPaths) if (!STATIC_FILES.includes(p)) changed.add(p);
  return [...changed];
}

/**
 * `--purge` — drop exactly what this deploy changed, decided from origin bytes captured by
 * `--snapshot` before the deploy and re-read after it.
 *
 * WHY NOT ASK THE EDGE. The obvious implementation — fetch each URL from the edge, compare
 * against origin, purge the ones that differ — is wrong, and wrong in the direction that
 * silently breaks pages. Cloudflare's cache is per-PoP, and a plain fetch reaches exactly one
 * PoP: whichever is nearest the runner. A URL that happens to be cold THERE misses, gets
 * filled from origin, compares byte-identical, and is skipped — while every other PoP keeps
 * serving the previous build for up to the full 30-day TTL. Worse, that very comparison warms
 * the runner's PoP, so the one vantage point the check can see is the one it just repaired.
 *
 * That is not hypothetical. On the 2026-07-30 deploy of #111 — which moved the bundle hash,
 * and therefore every one of the 132 URLs — the check reported `1/132 urls differ from origin`
 * and purged one. Minutes later IAD still served `/glossary` at age 12h referencing
 * `/assets/index-3uRpM-0Y.js` while ORD served the new build; at origin that filename returns
 * `text/html` (the SPA fallback answering 200 for a file the build deleted), so any PoP that
 * evicted the old asset while keeping the old HTML would serve a page whose module script is
 * HTML and never boot. The bias was systematic, and it fell hardest on exactly the cold
 * long-tail glossary pages the prerendering exists to serve.
 *
 * The origin has the property the edge lacks: one machine, same bytes for every caller. So
 * the question becomes "what did THIS deploy change", answered before/after against origin,
 * and the edge is never consulted. It also costs ~16 origin requests per deploy instead of
 * ~264, on a machine the deploy wakes anyway.
 *
 * The one thing this deliberately cannot do is repair staleness left by an EARLIER missed
 * purge — it only knows about this deploy. `edge-upkeep.yml` runs `--purge --force` weekly
 * for that, which is also what recovers the damage the old check already did.
 */
async function purge() {
  const sites = SITES.filter((s) => selectedHosts().includes(s.host));
  const force = process.argv.includes('--force');
  const sinceArg = process.argv.find((a) => a.startsWith('--since='))?.slice('--since='.length);

  let since = null;
  if (!force) {
    if (!sinceArg) throw new Error('--purge needs --since=<snapshot file> (or --force to skip the comparison)');
    try {
      const { readFile } = await import('node:fs/promises');
      since = JSON.parse(await readFile(sinceArg, 'utf8'));
    } catch (err) {
      // Fail SAFE, and loudly: a needless purge costs cold fills, a missed one serves a page
      // referencing deleted assets for up to 30 days.
      console.log(`::warning::could not read ${sinceArg} (${err.message}) — purging everything`);
    }
  }

  let files = [];
  for (const site of sites) {
    const paths = purgeUrls([site.host]).map((u) => new URL(u).pathname);
    if (force) {
      files.push(...paths.map((p) => `https://${site.host}${p}`));
      continue;
    }
    const sample = samplePaths();
    const after = await originHashes(site, sample);
    const changed = changedPaths(site, since, paths, after, sample);
    if (changed === null) {
      console.log(`${site.host}: no usable snapshot — purging all ${paths.length}`);
      files.push(...paths.map((p) => `https://${site.host}${p}`));
      continue;
    }
    console.log(`${site.host}: ${changed.length}/${paths.length} paths changed by this deploy`);
    files.push(...changed.map((p) => `https://${site.host}${p}`));
  }

  // Decided entirely from origin bytes, so a deploy that changed no cached output never
  // touches the Cloudflare API at all — and needs no token to say so.
  if (!files.length) {
    console.log('nothing to purge — this deploy changed no cached output.');
    return;
  }
  const id = await zoneId();
  for (let i = 0; i < files.length; i += PURGE_BATCH) {
    const batch = files.slice(i, i + PURGE_BATCH);
    await cf(`/zones/${id}/purge_cache`, { method: 'POST', body: JSON.stringify({ files: batch }) });
    console.log(`  purged ${batch.length} (${i + batch.length}/${files.length})`);
    if (i + PURGE_BATCH < files.length) await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`purged ${files.length} urls across ${sites.map((s) => s.host).join(', ')}`);
}

/**
 * Health of the things that fail silently and late.
 *
 * The certificate is the sharp one, and the trap is specific: Fly validates custom-domain
 * certs over TLS-ALPN by default, and Cloudflare terminates TLS, so the moment the record
 * goes orange that method stops working — with no symptom until the current certificate
 * expires weeks later. Fly's documented fix is `fly certs setup <host>` plus the
 * `_fly-ownership` TXT record, after which Let's Encrypt validates over HTTP-01 *through*
 * the proxy. Note it is specifically NOT DNS-01: Cloudflare's Universal SSL inserts its own
 * hidden `_acme-challenge` TXT records, which collide with Fly's.
 *
 * So this checks the OUTCOME (is the certificate renewing?) rather than the mechanism, plus
 * the one combination that is definitely broken — proxied with TLS-ALPN as the only
 * configured method. Checking "is DNS-01 configured?" was the earlier version of this and it
 * was wrong twice over: it failed a correctly configured HTTP-01 setup, and it recommended
 * the one method Fly warns against on Cloudflare.
 */
async function audit() {
  let failed = false;
  const fail = (msg) => {
    console.log(`::error::${msg}`);
    failed = true;
  };

  for (const site of SITES.filter((s) => selectedHosts().includes(s.host))) {
    console.log(`\n── ${site.host} (${site.app}) ──`);
    const siteFailed = await auditSite(site, fail);
    failed = failed || siteFailed;
  }

  if (failed) process.exitCode = 1;
  else console.log('\n✓ edge healthy.');
}

/** Probe one host's edge, then read its certificate in light of whether it is proxied. */
async function auditSite(site, fail) {
  const { host, app } = site;
  let localFailed = false;
  const bad = (msg) => {
    fail(msg);
    localFailed = true;
  };

  const SERVED_FROM_CACHE = ['HIT', 'EXPIRED', 'REVALIDATED', 'UPDATING', 'STALE'];
  let proxied = false;
  for (const path of ['/robots.txt', '/']) {
    const url = `https://${host}${path}`;
    // Anycast means consecutive requests can land on different edge servers, each with its
    // own cache — so a lone MISS proves nothing. Ask a few times and accept any cache hit;
    // only a run of pure misses means the rule is not doing its job.
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(url, { headers: { 'User-Agent': 'nickel-bridge-edge-audit' } });
      seen.push(r.headers.get('cf-cache-status'));
      if (r.headers.get('cf-ray')) proxied = true;
    }
    console.log(`· ${path}: cf-cache-status=${seen.map((x) => x ?? 'none').join(',')}`);
    if (!seen.some(Boolean)) {
      bad(`${url} is not going through Cloudflare (no cf-cache-status) — is the record proxied?`);
    } else if (!seen.some((x) => SERVED_FROM_CACHE.includes(x))) {
      bad(`${url} never served from cache across ${seen.length} fetches — it is still waking Fly`);
    }
  }

  // Session-scoped responses must never be cacheable, and this stays honest from outside.
  const api = await fetch(`https://${host}/api/me`);
  const apiStatus = api.headers.get('cf-cache-status');
  console.log(`· /api/me: cf-cache-status=${apiStatus ?? 'none'}`);
  if (apiStatus && !['BYPASS', 'DYNAMIC'].includes(apiStatus))
    bad(`${host}/api/me returned cf-cache-status=${apiStatus} — session-scoped responses must never cache`);

  const flyToken = process.env.FLY_API_TOKEN;
  if (!flyToken) {
    console.log('· cert: skipped (FLY_API_TOKEN not set)');
    return localFailed;
  }

  const q = `query($a:String!,$h:String!){app(name:$a){certificate(hostname:$h){
    isConfigured source clientStatus validationErrors{message}
    isAcmeAlpnConfigured isAcmeHttpConfigured isAcmeDnsConfigured
    issued{nodes{expiresAt}}}}}`;
  const res = await fetch('https://api.fly.io/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${flyToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, variables: { a: app, h: host } }),
  }).then((r) => r.json());

  const cert = res?.data?.app?.certificate;
  if (!cert) {
    bad(`${host}: could not read certificate state from Fly`);
    return localFailed;
  }

  const methods = [
    cert.isAcmeAlpnConfigured && 'tls-alpn',
    cert.isAcmeHttpConfigured && 'http-01',
    cert.isAcmeDnsConfigured && 'dns-01',
  ].filter(Boolean);
  const soonest = (cert.issued?.nodes ?? []).map((n) => new Date(n.expiresAt)).sort((a, b) => a - b)[0];
  const days = soonest ? Math.floor((soonest - Date.now()) / 86_400_000) : null;
  console.log(
    `· cert: ${days} days left, source=${cert.source}, status=${cert.clientStatus}, validation=[${methods.join(',') || 'none'}]`,
  );

  for (const e of cert.validationErrors ?? []) bad(`${host} cert validation: ${e.message}`);

  // An imported Cloudflare Origin Certificate never auto-renews, so it needs more warning.
  const threshold = cert.source === 'fly' ? 21 : 45;
  if (days !== null && days < threshold) {
    bad(
      cert.source === 'fly'
        ? `${host} cert expires in ${days} days and has not renewed — check \`fly certs check ${host}\``
        : `${host} imported cert expires in ${days} days and does NOT auto-renew — re-import it`,
    );
  }

  if (cert.source === 'fly') {
    if (!methods.length) {
      bad(`${host} cert has no working ACME validation method — renewal cannot happen.`);
    } else if (proxied && methods.length === 1 && methods[0] === 'tls-alpn') {
      // The specific broken combination: Cloudflare terminates TLS, so TLS-ALPN can't validate.
      //
      // These isAcme*Configured flags are a cache — Fly only recomputes them when it
      // re-validates, so a correctly configured host reads stale here until something pokes
      // it. That is not hypothetical: demo-bridge.brannon.online sat at [tls-alpn] with its
      // _fly-ownership TXT already published and live in DNS, and a single `fly certs check`
      // flipped it to [tls-alpn,http-01]. So lead with the re-check: it is the cheaper and
      // more likely fix, and doing it first turns a confusing false alarm into one command.
      bad(
        `${host} cert validates only over TLS-ALPN, which cannot work behind Cloudflare's proxy.\n` +
          `  If the _fly-ownership TXT is already published, this flag is just stale — run:\n` +
          `    fly certs check ${host} --app ${app}\n` +
          `  If it is genuinely missing, get it from \`fly certs setup ${host} --app ${app}\` first.`,
      );
    }
  }
  return localFailed;
}

const MODES = {
  '--plan': plan,
  '--apply': apply,
  '--check': check,
  '--snapshot': snapshot,
  '--purge': purge,
  '--audit': audit,
};
const mode = process.argv.find((a) => MODES[a]) ?? '--plan';

// A stack trace is the wrong thing to hand a CI log: the causes here are all operational
// (missing token, wrong zone, a tripped invariant) and each already carries a usable message.
try {
  assertFrontedHostsServable();
  await MODES[mode]();
} catch (err) {
  console.error(`::error::cloudflare.mjs ${mode}: ${err.message}`);
  process.exit(1);
}
