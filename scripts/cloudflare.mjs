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
 *   node scripts/cloudflare.mjs --purge    # drop the cached HTML surface (run after a deploy)
 *   node scripts/cloudflare.mjs --audit    # cert + cache health; fails on anything actionable
 *
 * ENV
 *   CLOUDFLARE_API_TOKEN  zone scoped: Zone:Read, Zone Settings:Edit, Cache Rules:Edit,
 *                         Cache Purge:Purge. Not needed for --plan.
 *   FLY_API_TOKEN         --audit only, to read the certificate's validation state.
 *   CF_ZONE_NAME          default 'brannon.online'
 *   SITE_HOST             default 'bridge.brannon.online'
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Imported from source across the workspace boundary, exactly as web/scripts/prerender.mjs
// does it: seo.ts is dependency-free and Node/DOM-free so native type-stripping is enough.
const { SITE_ROUTES } = await import(resolve(root, 'server/src/seo.ts'));

const ZONE_NAME = process.env.CF_ZONE_NAME ?? 'brannon.online';
const HOST = process.env.SITE_HOST ?? 'bridge.brannon.online';
const API = 'https://api.cloudflare.com/client/v4';

/** Vite content-hashes everything here, so a new build means a new filename. */
const IMMUTABLE_PREFIX = '/assets/';
/**
 * Files no router row covers but every crawler asks for. `/robots.txt` and `/sitemap.xml`
 * are the two that matter most: they are the first thing a crawler fetches, so caching
 * them is what turns a crawl visit into zero origin requests.
 */
const STATIC_FILES = ['/robots.txt', '/sitemap.xml', '/og-image.png', '/favicon.svg'];

const YEAR = 31_536_000;
const DAY = 86_400;

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

/** Does this matcher set cover a URL path? Mirrors seo.ts's `covers` semantics. */
function setMatches({ exacts, prefixes }, pathname) {
  return exacts.includes(pathname) || prefixes.some((p) => pathname.startsWith(p));
}

/** Cloudflare Ruleset-engine expression for a matcher set, scoped to this host. */
function expression({ exacts, prefixes }) {
  const parts = [];
  if (exacts.length) {
    parts.push(`http.request.uri.path in {${exacts.map((e) => JSON.stringify(e)).join(' ')}}`);
  }
  for (const p of prefixes) parts.push(`starts_with(http.request.uri.path, ${JSON.stringify(p)})`);
  return `(http.host eq ${JSON.stringify(HOST)}) and (${parts.join(' or ')})`;
}

/**
 * The desired cache ruleset. Rules are mutually exclusive by construction, so their order
 * carries no meaning — worth keeping that way, since Cloudflare resolves overlapping cache
 * rules by last-match-wins and that is an easy thing to get subtly wrong.
 */
export function buildRules() {
  const bypass = matcherSet(SITE_ROUTES.filter((r) => !r.spa).map((r) => r.path));
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
  ];
  for (const p of MUST_BYPASS) {
    if (setMatches(cached, p) || setMatches(immutable, p)) {
      throw new Error(`INVARIANT: ${p} would be CACHED. Never cache a session-scoped path.`);
    }
    if (!setMatches(bypass, p)) {
      throw new Error(`INVARIANT: ${p} is not covered by the bypass rule.`);
    }
  }
  // The gated SPA routes must not be cached either — they are live data behind the gate.
  for (const p of ['/t/29/b/2', '/activity', '/scenarios', '/leaderboard', '/players/7']) {
    if (setMatches(cached, p)) throw new Error(`INVARIANT: ${p} would be CACHED but is not indexed prose.`);
  }
  // And the whole point: the crawler surface must actually be covered.
  for (const p of ['/', '/robots.txt', '/sitemap.xml', '/og-image.png', '/glossary', '/glossary/squeeze']) {
    if (!setMatches(cached, p)) throw new Error(`INVARIANT: ${p} is not cached — crawlers would still wake the machine.`);
  }

  return [
    {
      description: 'Never cache the private surface (derived from seo.ts spa:false)',
      expression: expression(bypass),
      action: 'set_cache_settings',
      action_parameters: { cache: false },
    },
    {
      description: 'Content-hashed assets are immutable',
      expression: expression(immutable),
      action: 'set_cache_settings',
      action_parameters: {
        cache: true,
        edge_ttl: { mode: 'override_origin', default: YEAR },
        browser_ttl: { mode: 'override_origin', default: YEAR },
      },
    },
    {
      description: 'Crawler-facing surface (derived from seo.ts indexed:true) — stops the wakes',
      expression: expression(cached),
      action: 'set_cache_settings',
      action_parameters: {
        cache: true,
        edge_ttl: { mode: 'override_origin', default: DAY },
        // Short on purpose: the edge TTL is what suppresses origin wakes, while a long
        // browser TTL would strand a deploy in someone's tab. Purge handles the edge.
        browser_ttl: { mode: 'override_origin', default: 300 },
      },
    },
  ];
}

/** Every URL --purge drops: the cached HTML that a deploy actually changes. */
export function purgeUrls() {
  const indexed = SITE_ROUTES.filter((r) => r.indexed && !r.path.endsWith('/*')).map((r) => r.path);
  return [...new Set([...indexed, '/index.html', '/sitemap.xml', '/robots.txt'])].map(
    (p) => `https://${HOST}${p === '/' ? '/' : p}`,
  );
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

/** Compare only the fields we manage, so Cloudflare's server-side additions aren't "drift". */
const shape = (r) => ({
  description: r.description,
  expression: r.expression,
  action: r.action,
  action_parameters: r.action_parameters,
});

// ---------------------------------------------------------------- commands

async function plan() {
  const rules = buildRules();
  console.log(JSON.stringify({ host: HOST, zone: ZONE_NAME, rules, purge: purgeUrls() }, null, 2));
  console.log(`\n✓ ${rules.length} rules derived from seo.ts; all invariants hold.`);
}

async function apply() {
  const rules = buildRules();
  const id = await zoneId();

  const ssl = await cf(`/zones/${id}/settings/ssl`);
  if (ssl.value !== 'strict') {
    // Flexible + fly.toml's `force_https = true` is an infinite redirect loop, so this is
    // not a preference — it is the difference between a working site and an outage.
    await cf(`/zones/${id}/settings/ssl`, { method: 'PATCH', body: JSON.stringify({ value: 'strict' }) });
    console.log(`ssl: ${ssl.value} → strict`);
  } else {
    console.log('ssl: strict (unchanged)');
  }

  await cf(`/zones/${id}/rulesets/phases/${CACHE_PHASE}/entrypoint`, {
    method: 'PUT',
    body: JSON.stringify({ rules }),
  });
  console.log(`cache rules: applied ${rules.length}`);
  for (const r of rules) console.log(`  - ${r.description}`);
}

async function check() {
  const desired = buildRules().map(shape);
  const id = await zoneId();
  let live = [];
  try {
    const rs = await cf(`/zones/${id}/rulesets/phases/${CACHE_PHASE}/entrypoint`);
    live = (rs.rules ?? []).map(shape);
  } catch {
    live = [];
  }
  const ssl = await cf(`/zones/${id}/settings/ssl`);

  const problems = [];
  if (ssl.value !== 'strict') problems.push(`ssl mode is "${ssl.value}", expected "strict"`);
  if (JSON.stringify(live) !== JSON.stringify(desired)) {
    problems.push('cache ruleset differs from the config derived from seo.ts');
    console.log('--- live ---\n' + JSON.stringify(live, null, 2));
    console.log('--- desired ---\n' + JSON.stringify(desired, null, 2));
  }
  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`);
    console.log('\nRun: node scripts/cloudflare.mjs --apply');
    process.exitCode = 1;
    return;
  }
  console.log('✓ Cloudflare config matches seo.ts, ssl=strict.');
}

async function purge() {
  const files = purgeUrls();
  const id = await zoneId();
  await cf(`/zones/${id}/purge_cache`, { method: 'POST', body: JSON.stringify({ files }) });
  console.log(`purged ${files.length} urls:`);
  for (const f of files) console.log(`  - ${f}`);
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

  // Edge first: whether the host is proxied decides how to read the certificate state.
  let proxied = false;
  for (const path of ['/robots.txt', '/']) {
    const url = `https://${HOST}${path}`;
    let status = null;
    for (let i = 0; i < 2; i++) {
      const r = await fetch(url, { headers: { 'User-Agent': 'nickel-bridge-edge-audit' } });
      status = r.headers.get('cf-cache-status');
      if (r.headers.get('cf-ray')) proxied = true;
    }
    console.log(`· ${path}: cf-cache-status=${status ?? 'none'}`);
    if (!status) {
      fail(`${url} is not going through Cloudflare (no cf-cache-status) — is the record proxied?`);
    } else if (!['HIT', 'EXPIRED', 'REVALIDATED', 'UPDATING', 'STALE'].includes(status)) {
      fail(`${url} returned ${status} on a second consecutive fetch — it is still waking Fly`);
    }
  }

  // Session-scoped responses must never be cacheable, and this stays honest from outside.
  const api = await fetch(`https://${HOST}/api/me`);
  const apiStatus = api.headers.get('cf-cache-status');
  console.log(`· /api/me: cf-cache-status=${apiStatus ?? 'none'}`);
  if (apiStatus && !['BYPASS', 'DYNAMIC'].includes(apiStatus)) {
    fail(`/api/me returned cf-cache-status=${apiStatus} — session-scoped responses must never cache`);
  }

  const flyToken = process.env.FLY_API_TOKEN;
  if (!flyToken) {
    console.log('· cert: skipped (FLY_API_TOKEN not set)');
    if (failed) process.exitCode = 1;
    return;
  }

  const q = `query($a:String!,$h:String!){app(name:$a){certificate(hostname:$h){
    isConfigured source clientStatus validationErrors{message}
    isAcmeAlpnConfigured isAcmeHttpConfigured isAcmeDnsConfigured
    issued{nodes{expiresAt}}}}}`;
  const res = await fetch('https://api.fly.io/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${flyToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, variables: { a: process.env.FLY_APP ?? 'nickel-bridge', h: HOST } }),
  }).then((r) => r.json());

  const cert = res?.data?.app?.certificate;
  if (!cert) {
    fail('cert: could not read certificate state from Fly');
    process.exitCode = 1;
    return;
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

  for (const e of cert.validationErrors ?? []) fail(`cert validation: ${e.message}`);

  // An imported Cloudflare Origin Certificate never auto-renews, so it needs more warning.
  const threshold = cert.source === 'fly' ? 21 : 45;
  if (days !== null && days < threshold) {
    fail(
      cert.source === 'fly'
        ? `cert expires in ${days} days and has not renewed — check \`fly certs check ${HOST}\``
        : `imported cert expires in ${days} days and does NOT auto-renew — re-import it`,
    );
  }

  if (cert.source === 'fly') {
    if (!methods.length) {
      fail(`cert has no working ACME validation method — renewal cannot happen. Run \`fly certs check ${HOST}\`.`);
    } else if (proxied && methods.length === 1 && methods[0] === 'tls-alpn') {
      // The specific broken combination: Cloudflare terminates TLS, so TLS-ALPN can't validate.
      fail(
        `cert validates only over TLS-ALPN, which cannot work behind Cloudflare's proxy. ` +
          `Run \`fly certs setup ${HOST}\` and add the _fly-ownership TXT record so HTTP-01 validates through the proxy.`,
      );
    }
  }

  if (failed) process.exitCode = 1;
  else console.log('\n✓ edge healthy.');
}

const MODES = { '--plan': plan, '--apply': apply, '--check': check, '--purge': purge, '--audit': audit };
const mode = process.argv.find((a) => MODES[a]) ?? '--plan';

// A stack trace is the wrong thing to hand a CI log: the causes here are all operational
// (missing token, wrong zone, a tripped invariant) and each already carries a usable message.
try {
  await MODES[mode]();
} catch (err) {
  console.error(`::error::cloudflare.mjs ${mode}: ${err.message}`);
  process.exit(1);
}
