import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { MAX_HEADER_LOG_CHARS, serializeRequestLog } from '../src/logging.js';

/**
 * The `req` keys Fastify actually emits under a given serializer config — driven through a
 * real app rather than by importing fastify/lib/logger-pino.js, so the parity check below
 * rests on public API and survives Fastify moving its internals around.
 */
async function loggedReqKeys(useOurs: boolean): Promise<string[]> {
  const lines: string[] = [];
  const app = Fastify({
    logger: {
      level: 'info',
      stream: { write: (line: string) => void lines.push(line) },
      ...(useOurs ? { serializers: { req: serializeRequestLog } } : {}),
    },
  });
  app.get('/x', (_req, reply) => reply.send({ ok: true }));
  await app.inject({ method: 'GET', url: '/x', headers: { 'accept-version': '1.0.0' } });
  await app.close();
  const entry = lines.map((l) => JSON.parse(l)).find((l) => l.req);
  return Object.keys(entry.req).sort();
}

/**
 * The serializer is unit-tested directly rather than through app.inject(): the server
 * suites run at LOG_LEVEL=silent (see helpers.ts), so nothing would ever call it there.
 */
function request(
  headers: Record<string, string | string[]> = {},
  overrides: Partial<FastifyRequest> = {},
): FastifyRequest {
  return {
    method: 'GET',
    url: '/',
    host: 'bridge.brannon.online',
    ip: '172.16.18.186',
    socket: { remotePort: 60290 },
    headers,
    ...overrides,
  } as unknown as FastifyRequest;
}

describe('serializeRequestLog', () => {
  it('keeps every field Fastify logged before, including the proxy as remoteAddress', () => {
    expect(serializeRequestLog(request())).toMatchObject({
      method: 'GET',
      url: '/',
      host: 'bridge.brannon.online',
      remoteAddress: '172.16.18.186',
      remotePort: 60290,
    });
  });

  it('carries accept-version through, the one default field easy to drop by accident', () => {
    expect(serializeRequestLog(request({ 'accept-version': '1.2.0' })).version).toBe('1.2.0');
    expect(serializeRequestLog(request()).version).toBeUndefined();
  });

  // Naming `req` replaces Fastify's built-in serializer outright rather than extending it,
  // so anything it logs and we don't just disappears. Guard the superset, not a field list.
  it('logs every field Fastify would have logged by default', async () => {
    const [ours, theirs] = await Promise.all([loggedReqKeys(true), loggedReqKeys(false)]);
    expect(theirs.length).toBeGreaterThan(0);
    expect(ours).toEqual(expect.arrayContaining(theirs));
  });

  it('records the visitor from Fly-Client-IP, distinct from the proxy address', () => {
    const log = serializeRequestLog(request({ 'fly-client-ip': '203.0.113.7' }));
    expect(log.clientIp).toBe('203.0.113.7');
    expect(log.remoteAddress).toBe('172.16.18.186');
  });

  it('falls back to the first X-Forwarded-For entry when Fly-Client-IP is absent', () => {
    const log = serializeRequestLog(request({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' }));
    expect(log.clientIp).toBe('203.0.113.7');
  });

  // Behind a CDN, Fly-Client-IP is the CDN's edge address, not the visitor's — preferring
  // it would silently replace every logged caller with a Cloudflare IP.
  it('prefers CF-Connecting-IP over Fly-Client-IP when a CDN is genuinely in front', () => {
    const log = serializeRequestLog(
      request({
        'cf-ray': '9a1b2c3d4e5f6789-EWR',
        'cf-connecting-ip': '203.0.113.7',
        'fly-client-ip': '172.68.0.11',
        'x-forwarded-for': '203.0.113.7, 172.68.0.11',
      }),
    );
    expect(log.clientIp).toBe('203.0.113.7');
    expect(log.clientIpSource).toBe('cf-connecting-ip');
  });

  // A PR preview is never fronted by Cloudflare, and production keeps answering on its own
  // .fly.dev name even once the custom domain is proxied — so a bare CF-Connecting-IP is
  // just an attacker-supplied string, and must not displace the one Fly guarantees.
  it('ignores a forged CF-Connecting-IP that arrives with no Cloudflare hop', () => {
    const log = serializeRequestLog(
      request({ 'cf-connecting-ip': '1.2.3.4', 'fly-client-ip': '198.51.100.9' }),
    );
    expect(log.clientIp).toBe('198.51.100.9');
    expect(log.clientIpSource).toBe('fly-client-ip');
  });

  it('labels the source of every address it logs, so a suspect one is visible', () => {
    expect(serializeRequestLog(request({ 'fly-client-ip': '198.51.100.9' })).clientIpSource).toBe(
      'fly-client-ip',
    );
    expect(serializeRequestLog(request({ 'x-forwarded-for': '203.0.113.7' })).clientIpSource).toBe(
      'x-forwarded-for',
    );
    expect(serializeRequestLog(request()).clientIpSource).toBeUndefined();
  });

  it('prefers Fly-Client-IP over X-Forwarded-For', () => {
    const log = serializeRequestLog(
      request({ 'fly-client-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9' }),
    );
    expect(log.clientIp).toBe('203.0.113.7');
  });

  it('leaves clientIp unset for a flyd health check, which never crosses the proxy', () => {
    const log = serializeRequestLog(
      request({}, { url: '/health', host: '172.19.18.186:3000', ip: '172.19.18.185' }),
    );
    expect(log.clientIp).toBeUndefined();
    expect(log.userAgent).toBeUndefined();
  });

  it('records the user agent and referer', () => {
    const log = serializeRequestLog(
      request({ 'user-agent': 'Mozilla/5.0', referer: 'https://example.com/a' }),
    );
    expect(log.userAgent).toBe('Mozilla/5.0');
    expect(log.referer).toBe('https://example.com/a');
  });

  it('truncates an oversized header rather than logging it whole', () => {
    const log = serializeRequestLog(request({ 'user-agent': 'x'.repeat(5000) }));
    expect(log.userAgent).toHaveLength(MAX_HEADER_LOG_CHARS + 1); // + the ellipsis
    expect(log.userAgent?.endsWith('…')).toBe(true);
  });

  it('takes the first value of a repeated header', () => {
    const log = serializeRequestLog(request({ 'user-agent': ['first', 'second'] }));
    expect(log.userAgent).toBe('first');
  });

  it('treats blank and missing headers alike', () => {
    const log = serializeRequestLog(request({ 'user-agent': '   ', 'fly-client-ip': '' }));
    expect(log.userAgent).toBeUndefined();
    expect(log.clientIp).toBeUndefined();
  });
});
