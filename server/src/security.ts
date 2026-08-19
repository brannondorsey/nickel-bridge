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
 * - **Content-Security-Policy** — a set of rules a browser enforces about what
 *   this page may do. Deliberately NARROW here: it carries only the rules that
 *   forbid things the app never does, and NO allowlist of where scripts, styles,
 *   images, fonts or connections may come from. See `contentSecurityPolicy`
 *   below for why the allowlist half was taken back out.
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
 *   request is one a visitor can never be tricked into granting. The three
 *   motion sensors are the exception and are scoped to `(self)`; see
 *   `SELF_ONLY` below for what reads them and why the distinction matters.
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
/**
 * A year, the value HSTS is only meaningful at: the max-age is a *countdown
 * restarted on every response*, so it has to outlast the gap between one
 * visitor's visits, and a short one silently reopens the window it exists to
 * close.
 *
 * No `includeSubDomains`. HSTS is scoped by browsers to the exact host that
 * sent it — `bridge.brannon.online` or `demo-bridge.brannon.online` — never to
 * sibling hostnames on the shared zone, so the directive was never a leak risk
 * (the same blast-radius reasoning scripts/cloudflare.mjs applies to zone-wide
 * settings). It's left off anyway because it would be a no-op wearing the
 * shape of a decision: nothing lives under either app's own host today, so
 * there's nothing for it to include. If a real subdomain of one of these hosts
 * (`api.bridge.brannon.online`, say) is ever added, add it back deliberately
 * then, once there's an actual subdomain whose HTTPS-only posture this is
 * choosing.
 *
 * `preload` is deliberately absent. The preload list is keyed on the
 * registrable domain, so submitting would commit `brannon.online` and every
 * name under it — including those ten hosts on origins this repo knows nothing
 * about — to HTTPS-only, with removal taking months. Adding the token without
 * submitting would just be a claim nobody reads.
 */
const HSTS = 'max-age=31536000';

/**
 * Capabilities this app never uses, switched off for the whole document.
 * An empty allowlist `()` means "no origin, including this one".
 */
const DENIED = [
  'autoplay',
  'camera',
  'display-capture',
  'encrypted-media',
  'geolocation',
  'microphone',
  'midi',
  'payment',
  'usb',
];

/**
 * The motion sensors, allowed to THIS ORIGIN and nowhere else.
 *
 * These three sat in the denied list above, which was right while nothing
 * read them and is the reason this needed a deliberate edit rather than a
 * silent one. `deviceorientation` — the event behind the "foil trumps" tilt
 * treatment (web/public/foil-trumps-a-concept.html) — is gated on
 * `accelerometer` and `gyroscope`, and on `magnetometer` for the absolute
 * variant some Android builds populate instead. Denied, the events simply
 * never arrive: no error, no prompt, no console warning, which is a
 * genuinely miserable thing to debug and cost a round of it here.
 *
 * `(self)` rather than `*` is the whole point of spending the header at all.
 * The default allowlist for these features is already `self`, so writing it
 * out changes nothing a browser does today — what it does is state the
 * decision where the next person looking at this list will see it, and keep
 * a cross-origin iframe embedded in one of our pages from inheriting them.
 * Note the inverse of that rule is why the concept board cannot work as a
 * hosted artifact and has to be served from here: a cross-origin frame is
 * denied these by default, and no markup inside the frame can grant them.
 *
 * If the tilt is cut, move these three back to DENIED in the same change.
 */
const SELF_ONLY = ['accelerometer', 'gyroscope', 'magnetometer'];

const PERMISSIONS = [
  ...DENIED.map((feature) => `${feature}=()`),
  ...SELF_ONLY.map((feature) => `${feature}=(self)`),
].join(', ');

/**
 * The Content-Security-Policy — the RULES half only, with no allowlist.
 *
 * This shipped once with the full thing: `default-src 'self'` plus per-type
 * allowlists for scripts, styles, images, fonts and connections, naming
 * gtag.js, Google's avatar hosts and GA's collectors, with the shell's two
 * pre-paint inline scripts admitted by SHA-256 hash. It was correct, and it was
 * taken back out on purpose. Read this before adding it back.
 *
 * WHY. An allowlist is a second, invisible copy of every external thing the app
 * loads, and it is enforced in exactly one place a developer never looks: a
 * production browser. `npm run dev -w web` serves through Vite, which sends no
 * such header, and jsdom ignores it — so adding a font host, an embedded
 * widget or a third-party script would work everywhere it was tested and fail
 * silently for real visitors. The prize for carrying that is containment of an
 * XSS this app has no known sink for: React escapes by default and there is no
 * `dangerouslySetInnerHTML` anywhere in web/src. A control whose expected cost
 * is a silent production breakage and whose expected benefit is insurance
 * against a bug nobody has written is not obviously worth having, and this one
 * was judged not to be.
 *
 * WHAT IS LEFT is everything that forbids what the app never does anyway, so
 * there is no list to keep in step with the code:
 *   frame-ancestors 'none'   nobody may frame this app — the clickjacking
 *                            answer, and the modern spelling of the
 *                            X-Frame-Options header sent beside it.
 *   base-uri 'none'          an injected <base> would silently repoint every
 *                            relative URL on the page, including the module
 *                            bundle's. Nothing here sets a <base>.
 *   object-src 'none'        no <object>/<embed>. Legacy plugin content is a
 *                            script-execution path with no use here.
 *   form-action 'self'       a form may only post back to this origin. Sign-in
 *                            is a link to /auth/google, and the one real form
 *                            (dev login) posts via fetch.
 * None of these can block a script, style, image, font or fetch, which is to
 * say none of them can break a page by being out of date.
 *
 * IF IT EVER COMES BACK, the way to make it safe is to make it visible: put the
 * allowlist behind `Content-Security-Policy-Report-Only` with somewhere for the
 * reports to land first, and only enforce what has been observed to be quiet.
 * Shipping it enforced on the strength of reading the code is how you get the
 * failure described above.
 */
export function contentSecurityPolicy(): string {
  return [`frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`, `form-action 'self'`].join('; ');
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
export function securityHeaders(opts: { hsts: boolean }): Record<string, string> {
  return {
    'content-security-policy': contentSecurityPolicy(),
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': PERMISSIONS,
    ...(opts.hsts ? { 'strict-transport-security': HSTS } : {}),
  };
}
