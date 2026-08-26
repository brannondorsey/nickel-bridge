/**
 * BASE_URL — this deployment's public origin, parsed in exactly one place.
 *
 * Three things need it: the session cookie's `Secure` flag and the Google
 * OAuth redirect URI (both `auth.ts`), and robots.txt's `Sitemap:` directive
 * (`app.ts`). They used to parse it three different ways with three different
 * fallbacks — `?? ''`, `?? 'http://localhost:3000'`, and a regex — which is
 * how a value that is neither absent nor valid went unnoticed: Vite defines a
 * BASE_URL of its own (its public base path, default `"/"`) and Vitest puts it
 * on `process.env`, so under the test runner this reads `"/"`. That silently
 * produced a relative Sitemap directive, and `'/'.startsWith('https')` is
 * false, so it would equally have silently un-Secured a cookie.
 *
 * Two exports, deliberately split:
 *
 * - `PUBLIC_ORIGIN` is LENIENT. It falls back to the dev origin rather than
 *   throwing, because it's evaluated at import time and every server test
 *   imports it with BASE_URL set to Vite's `"/"`. A module-level throw here
 *   would take out the whole suite.
 * - `assertPublicOrigin()` is where misconfiguration is caught, called once
 *   from `index.ts` at boot — the only place that knows it's a real process
 *   and not a test importing a module.
 */

/** Where the app answers when BASE_URL says nothing usable. */
const DEV_ORIGIN = 'http://localhost:3000';

/**
 * The absolute origin BASE_URL names, or null if it doesn't name one.
 *
 * Rejects everything the three old parsers let through in one form or
 * another: unset, empty, Vite's `"/"`, a bare hostname, a non-web protocol,
 * and `"https://"` — which is what `docker-compose.yml`'s
 * `BASE_URL: https://${DOMAIN}` collapses to when DOMAIN is empty, and which
 * the old `.startsWith('https')` cookie check would have accepted.
 */
export function parsePublicOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return `${url.protocol}//${url.host}`;
}

/** This deployment's public origin — absolute, no trailing slash. */
export const PUBLIC_ORIGIN = parsePublicOrigin(process.env.BASE_URL) ?? DEV_ORIGIN;

/**
 * The host BASE_URL names, or null when BASE_URL configures no origin.
 *
 * This is deliberately NOT `new URL(PUBLIC_ORIGIN).host`. PUBLIC_ORIGIN falls
 * back to the dev origin so tests and an unconfigured local run keep working,
 * and a fallback is precisely the case where there is no canonical host to
 * speak of — deriving one from it would tell a preview app with no BASE_URL
 * that its canonical home is `localhost:3000`, and auth.ts would send every
 * visitor there.
 *
 * What it exists for: this app answers on more than one hostname. Production
 * is `bridge.brannon.online` but the same machine also serves
 * `nickel-bridge.fly.dev` directly (Cloudflare fronts the first; the second is
 * the unproxied origin, and is what `scripts/cloudflare.mjs` compares bytes
 * against). Anything that mixes a per-host cookie with an origin-derived URL
 * breaks across that split — see the OAuth entry point in auth.ts.
 */
export const CANONICAL_HOST: string | null = canonicalHost(process.env.BASE_URL);

/** The host of the origin `raw` names, or null if it names none. */
export function canonicalHost(raw: string | undefined): string | null {
  const origin = parsePublicOrigin(raw);
  return origin === null ? null : new URL(origin).host;
}

/**
 * Whether a request's `Host` header names this deployment's canonical host.
 *
 * Two callers, both consequences of the same split: the OAuth entry point
 * (auth.ts), which bounces to the canonical origin before any state cookie
 * exists, and the noindex hook (app.ts), which keeps the non-canonical
 * hostname out of the search index. Two hand-written copies of one compare is
 * exactly the drift this codebase spends its comments avoiding — and the two
 * halves getting out of step here is silent in both directions.
 *
 * Lowercased because a Host header is case-insensitive while a string compare
 * is not, and CANONICAL_HOST comes out of `new URL().host`, which is already
 * normalized. A mixed-case `Host: Bridge.Brannon.Online` is the canonical host
 * and must be treated as one.
 *
 * Returns TRUE when there is no canonical host to compare against — a
 * deployment with no usable BASE_URL (local dev, a preview that never set one)
 * has no non-canonical hostname either, so nothing should redirect and nothing
 * should be noindexed. Both callers phrase their check so that this fails
 * safe: `if (!isCanonicalHost(...))` does nothing at all when BASE_URL is
 * absent.
 */
export function isCanonicalHost(host: string | undefined): boolean {
  if (CANONICAL_HOST === null) return true;
  return host?.toLowerCase() === CANONICAL_HOST;
}

/**
 * Whether cookies this app sets should carry `Secure`.
 *
 * Note this still derives from configuration rather than from the request that
 * is setting the cookie, so an https deployment that forgets BASE_URL entirely
 * gets non-Secure session cookies — `assertPublicOrigin` warns loudly about
 * exactly that case, but warning is not preventing. Deriving it from the
 * request protocol instead needs Fastify's `trustProxy` (every deployment sits
 * behind Fly's proxy) and is a separate change.
 */
export const COOKIES_SECURE = PUBLIC_ORIGIN.startsWith('https:');

type Logger = { warn: (msg: string) => void };

/**
 * Boot-time check. Call once from the entry point, before listen.
 *
 * Throws when BASE_URL is SET but unusable, because that is unambiguously a
 * misconfiguration and every consequence of it is silent: a broken OAuth
 * redirect, a Sitemap pointing at localhost, session cookies without `Secure`.
 * Failing to start is the loudest available signal and the cheapest to debug.
 *
 * Only warns when BASE_URL is UNSET, which is the documented local-dev shape
 * (`DEV_AUTH=1 npm run dev`). Refusing to boot there would break the workflow
 * the README tells contributors to use — and on a real deployment that has
 * always run without it, refusing would turn a latent weakness into an outage.
 */
export function assertPublicOrigin(log: Logger): void {
  const raw = process.env.BASE_URL;
  // An EMPTY BASE_URL counts as absent, not as broken — it warns, it doesn't
  // throw. `BASE_URL=` and an unset BASE_URL are the same thing to most shell
  // and container tooling (`docker run -e BASE_URL` forwards an empty value
  // when the host doesn't set one), and the throw below is aimed at values
  // that are clearly a typo or a collapsed template — `https://`, `/`,
  // `ftp://…` — rather than at "nothing was configured here". Same reasoning
  // as warning rather than throwing on unset: neither case should take down a
  // deployment that is running today.
  if (raw && parsePublicOrigin(raw) === null) {
    throw new Error(
      `BASE_URL is set to ${JSON.stringify(raw)}, which is not an absolute http(s) URL. ` +
        `Set it to this deployment's public origin (e.g. https://bridge.brannon.online), or unset it to use ${DEV_ORIGIN}.`,
    );
  }
  if (!raw) {
    log.warn(
      `BASE_URL is not set — using ${DEV_ORIGIN}. The Google OAuth redirect and robots.txt's ` +
        `sitemap link will point there, and session cookies will NOT be marked Secure.`,
    );
  }
}
