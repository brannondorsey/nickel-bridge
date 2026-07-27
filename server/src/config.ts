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
