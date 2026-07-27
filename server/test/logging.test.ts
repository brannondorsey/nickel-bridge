import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { MAX_HEADER_LOG_CHARS, serializeRequestLog } from '../src/logging.js';

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

  it('records the visitor from Fly-Client-IP, distinct from the proxy address', () => {
    const log = serializeRequestLog(request({ 'fly-client-ip': '203.0.113.7' }));
    expect(log.clientIp).toBe('203.0.113.7');
    expect(log.remoteAddress).toBe('172.16.18.186');
  });

  it('falls back to the first X-Forwarded-For entry when Fly-Client-IP is absent', () => {
    const log = serializeRequestLog(request({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' }));
    expect(log.clientIp).toBe('203.0.113.7');
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
