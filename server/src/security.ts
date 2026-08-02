/**
 * The response headers a browser only enforces if we ask it to.
 *
 * Everything here is a *browser-side* control: the server is already the one
 * deciding what to send, so none of these change what this app does. They
 * change what a browser is willing to do with what it receives — which is the
 * half of the trust boundary the origin cannot police on its own. That makes
 * them defense in depth by definition, and it is also why they are cheap: one
 * onSend hook, no request-time work, no per-route knowledge.
 *
 * They are set in ONE place (app.ts's hook, from this table) rather than at the
 * edge, for the same reason robots.txt is derived from seo.ts rather than kept
 * by hand: production, the demo app and every PR preview run the same
 * `buildApp()`, so an app-level header is true of all of them the moment it
 * ships. A Cloudflare Response Header Transform Rule would have covered only
 * the two fronted hosts, only after `--apply` ran, and only for as long as
 * nobody replaced the ruleset (see CLAUDE.md, "The edge" — a phase entrypoint
 * deploy is a zone-wide PUT). Cloudflare passes origin response headers through
 * untouched, so the fronted hosts serve exactly these.
 *
 * WHAT EACH ONE IS FOR, since a header nobody understands is a header the next
 * person deletes:
 *
 * - **Content-Security-Policy** — an allowlist of where the page may load code,
 *   styles, images, fonts and network connections from, enforced by the
 *   browser. Its job is to make an injected `<script>` inert: an XSS that
 *   cannot fetch its payload or run inline is a defacement rather than a
 *   session theft. This app has no known injection sink (React escapes by
 *   default and there is no `dangerouslySetInnerHTML` anywhere in web/src), so
 *   this is insurance against the sink nobody has written yet — which is the
 *   only time it can be added cheaply, because the policy below is written
 *   against what the app loads *today*.
 * - **frame-ancestors / X-Frame-Options** — who may put this app in an iframe.
 *   The answer is nobody. The session cookie is `SameSite=Lax`, which rides
 *   same-origin subrequests inside a framed page, so a framed board is a live,
 *   authenticated board that an attacker's page can position under an invisible
 *   overlay and steer a click into (clickjacking). What that buys today is
 *   small — the reachable state changes are preference toggles and a two-tap
 *   bid — but "small" is a property of this month's UI, not of the header.
 *   Both spellings are sent: `frame-ancestors` is the modern one and wins where
 *   both are understood; `X-Frame-Options` is what an older browser reads.
 * - **X-Content-Type-Options: nosniff** — forbids MIME sniffing. Without it a
 *   browser may ignore a declared `Content-Type` and execute a response as
 *   script based on its bytes. Every route here sends an explicit type, so this
 *   mostly guards the next one that forgets — and it costs nothing.
 * - **Referrer-Policy** — how much of the current URL is sent to a site the
 *   visitor clicks through to. `strict-origin-when-cross-origin` sends the full
 *   URL within this origin, bare origin to other HTTPS sites, and nothing when
 *   downgrading to HTTP. It matters here because the glossary links out to
 *   Wikipedia and Creative Commons from pages whose paths can name a
 *   tournament, a board or a player id. This is most browsers' default already;
 *   stating it removes the dependency on that staying true.
 * - **Permissions-Policy** — switches off browser capabilities the app never
 *   asks for (camera, microphone, geolocation, …). Nothing here would prompt
 *   for them today; the header means injected or third-party code in this
 *   document cannot prompt for them either, and a permission the page cannot
 *   request is one a visitor can never be tricked into granting.
 * - **Strict-Transport-Security** — tells the browser to remember, for a year,
 *   that this origin is HTTPS-only, so it upgrades `http://` internally instead
 *   of sending a plaintext request that can be intercepted. `force_https` in
 *   fly.toml redirects, but a redirect is an answer to a request that already
 *   left the device: on a hostile network the classic sslstrip attack answers
 *   it first and keeps the visitor on HTTP, where the session cookie and the
 *   OAuth flow are readable. HSTS closes that window for every visit after the
 *   first. See `securityHeaders`'s `hsts` argument for why it is conditional
 *   and `PRELOAD` below for why it is not preloaded.
 */
import { createHash } from 'node:crypto';

/** gtag.js's origin — the one third-party script the app loads (analytics.ts). */
const GTAG = 'https://www.googletagmanager.com';

/**
 * Where GA4 sends its hits. `*.google-analytics.com` and
 * `*.analytics.google.com` cover the regional collectors gtag picks at runtime
 * (`region1.google-analytics.com` and friends), which is not a list this file
 * can enumerate.
 */
const GA_COLLECT = [
  'https://www.google-analytics.com',
  'https://*.google-analytics.com',
  'https://*.analytics.google.com',
];

/**
 * Google account avatars — `users.picture`, straight from the OAuth profile and
 * rendered by Player.tsx and Compare.tsx. Wildcarded because Google serves them
 * from a rotating set of `lh*.googleusercontent.com` hosts.
 */
const AVATARS = 'https://*.googleusercontent.com';

/**
 * A year, the value HSTS is only meaningful at: the max-age is a *countdown
 * restarted on every response*, so it has to outlast the gap between one
 * visitor's visits, and a short one silently reopens the window it exists to
 * close.
 *
 * `includeSubDomains` is safe here in a way it would not be at the apex:
 * browsers scope it to the host that sent it, and nothing lives under
 * `bridge.brannon.online` or `demo-bridge.brannon.online`. The zone's ten other
 * hostnames are siblings, not subdomains, and are untouched — the same
 * blast-radius reasoning scripts/cloudflare.mjs applies to zone-wide settings.
 *
 * `preload` is deliberately absent. The preload list is keyed on the
 * registrable domain, so submitting would commit `brannon.online` and every
 * name under it — including those ten hosts on origins this repo knows nothing
 * about — to HTTPS-only, with removal taking months. Adding the token without
 * submitting would just be a claim nobody reads.
 */
const HSTS = 'max-age=31536000; includeSubDomains';

/**
 * Capabilities this app never uses, switched off for the whole document.
 * An empty allowlist `()` means "no origin, including this one".
 */
const PERMISSIONS = [
  'accelerometer',
  'autoplay',
  'camera',
  'display-capture',
  'encrypted-media',
  'geolocation',
  'gyroscope',
  'magnetometer',
  'microphone',
  'midi',
  'payment',
  'usb',
]
  .map((feature) => `${feature}=()`)
  .join(', ');

/**
 * The script types a browser will actually execute. A `<script>` carrying
 * anything else — `application/ld+json`, which both the SPA shell and every
 * prerendered page use for structured data — is a data block the browser never
 * runs, and CSP therefore never checks it. Hashing those would be noise in the
 * header and, worse, would imply they are code.
 */
const EXECUTABLE_TYPES = new Set(['module', 'text/javascript', 'application/javascript', 'text/ecmascript']);

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/**
 * CSP hashes for the inline scripts in a page of HTML, in `'sha256-…'` form.
 *
 * web/index.html carries two inline scripts by necessity — the pre-paint theme
 * and suit-palette appliers, which must run before the module graph loads or a
 * night-mode visitor gets a light flash (see CLAUDE.md, "Night mode"). Under
 * `script-src 'self'` a browser refuses to run them, so the policy has to name
 * them somehow. A hash is the way to do that without `'unsafe-inline'`, which
 * would re-admit every injected inline script and leave a policy that mostly
 * decorates.
 *
 * Derived from the HTML this server is about to serve rather than hardcoded, so
 * an edit to those scripts cannot leave a stale constant behind: the prerendered
 * pages are copies of the built shell with only the SEO span and #root replaced
 * (web/scripts/prerender.mjs), so one read of the shell covers all ~127 pages.
 *
 * Failure is soft on purpose. If the shell can't be read, or its markup changes
 * shape enough that nothing matches, the app still runs — the module bundle is
 * `'self'` and unaffected — and the only symptom is a flash of the wrong theme
 * on first paint. security.test.ts pins the extraction against the real file so
 * that stays hypothetical.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const [, attrs, body] of html.matchAll(SCRIPT_TAG)) {
    if (/\bsrc\s*=/i.test(attrs)) continue; // external: covered by script-src 'self'
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && !EXECUTABLE_TYPES.has(type)) continue;
    hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return [...hashes];
}

/**
 * The Content-Security-Policy, assembled from what this app actually loads.
 *
 * Read it as a list of the only things a page here may do:
 *   default-src 'self'   everything not named below comes from this origin —
 *                        the fallback that makes an omitted directive safe
 *                        rather than open.
 *   script-src           this origin, the two pre-paint inline scripts by hash,
 *                        and gtag.js. No 'unsafe-inline', no 'unsafe-eval'.
 *   style-src            'unsafe-inline' is required and is the one real
 *                        concession: the prerendered pages embed a <style>
 *                        block of their own (prerender.mjs's STYLE). Style
 *                        injection is a defacement/exfil-by-selector risk, not
 *                        a code-execution one; hashing it would couple this
 *                        module to a build script's string literal for a much
 *                        smaller prize than script-src's.
 *   img-src              this origin, data: URIs (Vite inlines small assets),
 *                        Google avatars, and GA's collectors — the same list
 *                        connect-src gets, regional hosts included, because a
 *                        hit that falls back to an image beacon picks its host
 *                        the same way the beacon would. Narrowing this to the
 *                        bare collector would cost a silently dropped page
 *                        view, which is the kind of failure nobody notices.
 *   font-src 'self'      the faces are self-hosted via @fontsource. No CDN.
 *   connect-src          fetch/XHR/sendBeacon: this origin plus GA's
 *                        collectors.
 *   frame-ancestors      nobody may frame this app — see the header notes above.
 *   frame-src 'none'     and this app frames nobody. It embeds no third-party
 *                        widget, so an injected iframe has no legitimate twin.
 *   base-uri 'none'      an injected <base> would silently repoint every
 *                        relative URL on the page, including the module
 *                        bundle's, and 'self' does not stop that.
 *   form-action 'self'   a form here may only post back to this origin. Sign-in
 *                        is a link to /auth/google, not a cross-origin form.
 *   object-src 'none'    no <object>/<embed>. Legacy plugin content is a
 *                        script-execution path with no use here.
 */
export function contentSecurityPolicy(scriptHashes: readonly string[] = []): string {
  return [
    `default-src 'self'`,
    `script-src 'self' ${[...scriptHashes, GTAG].join(' ')}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: ${AVATARS} ${GA_COLLECT.join(' ')}`,
    `font-src 'self'`,
    `connect-src 'self' ${[GTAG, ...GA_COLLECT].join(' ')}`,
    `frame-ancestors 'none'`,
    `frame-src 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ].join('; ');
}

/**
 * Every security header this app sends, as a plain object app.ts can spread
 * onto a reply.
 *
 * `hsts` is the caller's answer to "is this deployment actually served over
 * HTTPS?" — config.ts's COOKIES_SECURE, i.e. BASE_URL's scheme, the same one
 * parse everything else hangs off. It is a condition rather than an
 * unconditional send because HSTS is a *sticky* instruction: a browser that
 * receives it pins the origin for a year, and `http://localhost:3000` is a real
 * origin a contributor shares across projects. Browsers ignore the header when
 * it arrives over plaintext, so this is belt and braces — but the failure mode
 * it guards is "every localhost project on this machine is now unreachable over
 * HTTP", which is worth two lines of care.
 */
export function securityHeaders(opts: {
  hsts: boolean;
  scriptHashes?: readonly string[];
}): Record<string, string> {
  return {
    'content-security-policy': contentSecurityPolicy(opts.scriptHashes),
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': PERMISSIONS,
    ...(opts.hsts ? { 'strict-transport-security': HSTS } : {}),
  };
}
