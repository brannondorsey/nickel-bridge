import type { FastifyRequest } from 'fastify';

/**
 * What a request line in the log says.
 *
 * Fastify's default `req` serializer records method/url/host plus the socket peer — and
 * behind Fly's proxy that peer is always the proxy itself (172.16.x), never the visitor.
 * That gap made a real question unanswerable in July 2026: production's machine time had
 * escalated from ~0.2 h/day to ~22 h/day, and since `auto_stop_machines = 'suspend'` bills
 * a dedicated performance-1x core for the whole idle window that follows *any* request,
 * the entire cost question reduced to who was knocking. The logs could not say. Bot vs.
 * browser had to be inferred indirectly, from whether a bare `GET /` was followed by the
 * asset requests a real browser would always make.
 *
 * So record what Fly already hands us. `Fly-Client-IP` is the actual peer, and the user
 * agent is what separates a crawler from a person in one glance. Two details worth knowing
 * when reading the output:
 *
 * - Fly's health checks reach the machine directly from flyd rather than through the
 *   proxy, so they carry no `Fly-Client-IP` at all. That absence is itself the tell: a
 *   request with no `clientIp` did not come from the internet and did not wake anything.
 * - `remoteAddress` is kept exactly as before (Fastify's `request.ip`, i.e. the proxy)
 *   rather than being quietly redefined to mean the visitor. Anything already reading
 *   these lines keeps working, and the two addresses stay separately legible.
 *
 * Header values are attacker-controlled and Fastify accepts headers up to its 16 KB limit,
 * so each one is truncated — an unbounded log line is a cheap way to make logs unreadable.
 */

/** Longest a single logged header value may be before it is cut short. */
export const MAX_HEADER_LOG_CHARS = 256;

export type RequestLog = {
  method: string;
  url: string;
  version?: string;
  host?: string;
  remoteAddress?: string;
  remotePort?: number;
  clientIp?: string;
  clientIpSource?: string;
  userAgent?: string;
  referer?: string;
};

type Headers = FastifyRequest['headers'];

/**
 * One usable string from a raw header, or undefined. Repeated headers arrive as an array;
 * the first wins, matching how every consumer here treats them.
 */
function headerText(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_HEADER_LOG_CHARS
    ? `${trimmed.slice(0, MAX_HEADER_LOG_CHARS)}…`
    : trimmed;
}

/**
 * The visitor's own address, from the innermost proxy outward — and which header said so.
 *
 * Order matters, and gets this backwards if you reason from "Fly is our host, so trust Fly's
 * header". Fly sets `Fly-Client-IP` to whoever connected to *Fly*, which once a CDN sits in
 * front is the CDN's edge rather than the visitor — so a Cloudflare-proxied deployment
 * reading only that header would log Cloudflare IPs for every request and lose the one field
 * this module exists to provide. `CF-Connecting-IP` carries the real client there.
 *
 * **None of these headers are authenticated, and `CF-Connecting-IP` is only stripped at
 * Cloudflare's own edge — for traffic that actually passes through it.** Plenty here does
 * not: every PR preview answers on `nickel-bridge-pr-N.fly.dev` and is never fronted by
 * Cloudflare, and production and demo keep answering on their own `.fly.dev` names even once
 * the custom domain is proxied. On any of those, a client can simply set `CF-Connecting-IP`
 * itself. So this pairs it with `CF-Ray` — the same signal scripts/cloudflare.mjs's audit
 * uses to decide whether a host is really proxied — which raises forgery from one header to
 * two and nothing more. It is a consistency check, not a trust boundary.
 *
 * What makes that acceptable is `clientIpSource`: every line records which header produced
 * the value, so a `cf-connecting-ip` source on a request that had no business carrying one
 * is visible rather than silently authoritative. `fly-client-ip` is the only entry Fly
 * guarantees. **Nothing may make a security decision on any of this** — it is diagnostics,
 * and it is why this returns a labelled value instead of a bare string. If it ever does back
 * a decision, the real fix is checking `Fly-Client-IP` against Cloudflare's published edge
 * ranges, which is a different and much larger commitment.
 *
 * `X-Forwarded-For` is last: a client-to-proxy chain, so the first entry is the originating
 * request, covering any other front end (or local dev behind a proxy).
 */
type ClientIp = { ip?: string; source?: string };

function clientIp(headers: Headers): ClientIp {
  if (headerText(headers['cf-ray'])) {
    const cfConnectingIp = headerText(headers['cf-connecting-ip']);
    if (cfConnectingIp) return { ip: cfConnectingIp, source: 'cf-connecting-ip' };
  }
  const flyClientIp = headerText(headers['fly-client-ip']);
  if (flyClientIp) return { ip: flyClientIp, source: 'fly-client-ip' };
  const forwarded = headerText(headers['x-forwarded-for'])?.split(',')[0]?.trim();
  if (forwarded) return { ip: forwarded, source: 'x-forwarded-for' };
  return {};
}

/**
 * Fastify's default request log line, plus who sent it.
 *
 * Strictly additive on purpose: Fastify merges user serializers over its built-ins per key,
 * so naming `req` replaces the default one wholesale rather than extending it. Every field
 * `logger-pino.js` emits is therefore repeated here — including `version`, which this app
 * never sets (it comes from `accept-version`, for Fastify's constrained routing) but which
 * would otherwise silently vanish from the logs of anything that does.
 */
export function serializeRequestLog(req: FastifyRequest): RequestLog {
  const { ip, source } = clientIp(req.headers);
  return {
    method: req.method,
    url: req.url,
    version: req.headers?.['accept-version'] as string | undefined,
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
    clientIp: ip,
    clientIpSource: source,
    userAgent: headerText(req.headers['user-agent']),
    referer: headerText(req.headers.referer),
  };
}
