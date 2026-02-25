import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import correlationId from '../../src/plugins/correlation-id.js';

/**
 * Tests for the correlation-id plugin (T-006).
 *
 * Verifies X-Request-ID header propagation, UUID v4 generation when absent,
 * and response header set per REQ-014.
 */

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(correlationId);

  app.get('/test', async (request) => {
    return { correlationId: request.correlationId };
  });

  await app.ready();
  return app;
}

describe('correlation-id plugin', () => {
  it('propagates X-Request-ID from incoming request header', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-request-id': 'my-custom-id-123' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('my-custom-id-123');
    expect(res.json().correlationId).toBe('my-custom-id-123');
    await app.close();
  });

  it('generates UUID v4 when X-Request-ID is absent', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/test' });

    expect(res.statusCode).toBe(200);
    const id = res.headers['x-request-id'] as string;
    expect(id).toMatch(UUID_V4_REGEX);
    expect(res.json().correlationId).toBe(id);
    await app.close();
  });

  it('generates UUID v4 when X-Request-ID is empty string', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-request-id': '' },
    });

    const id = res.headers['x-request-id'] as string;
    expect(id).toMatch(UUID_V4_REGEX);
    expect(res.json().correlationId).toBe(id);
    await app.close();
  });

  it('sets X-Request-ID on response header', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/test' });

    expect(res.headers['x-request-id']).toBeDefined();
    expect(typeof res.headers['x-request-id']).toBe('string');
    await app.close();
  });

  it('preserves special characters in propagated X-Request-ID', async () => {
    const app = await buildApp();
    const customId = 'trace-abc123-def456-ghi789';
    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-request-id': customId },
    });

    expect(res.headers['x-request-id']).toBe(customId);
    expect(res.json().correlationId).toBe(customId);
    await app.close();
  });

  it('gives distinct correlation IDs to concurrent requests without header', async () => {
    const app = await buildApp();
    const [res1, res2, res3] = await Promise.all([
      app.inject({ method: 'GET', url: '/test' }),
      app.inject({ method: 'GET', url: '/test' }),
      app.inject({ method: 'GET', url: '/test' }),
    ]);

    const ids = new Set([
      res1.headers['x-request-id'],
      res2.headers['x-request-id'],
      res3.headers['x-request-id'],
    ]);
    expect(ids.size).toBe(3);
    await app.close();
  });

  it('generated correlation ID is a valid UUID v4 format', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/test' });

    const id = res.json().correlationId;
    expect(id).toMatch(UUID_V4_REGEX);
    await app.close();
  });

  it('rejects X-Request-ID exceeding max length and generates UUID', async () => {
    const app = await buildApp();
    const longId = 'x'.repeat(300);
    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-request-id': longId },
    });

    const id = res.headers['x-request-id'] as string;
    expect(id).not.toBe(longId);
    expect(id).toMatch(UUID_V4_REGEX);
    expect(res.json().correlationId).toBe(id);
    await app.close();
  });

  it('rejects X-Request-ID containing control characters', async () => {
    const app = await buildApp();
    const idWithNewline = 'trace-id\ninjected-log-line';
    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-request-id': idWithNewline },
    });

    const id = res.headers['x-request-id'] as string;
    expect(id).not.toBe(idWithNewline);
    expect(id).toMatch(UUID_V4_REGEX);
    await app.close();
  });

  it('rejects X-Request-ID containing null bytes', async () => {
    const app = await buildApp();
    const idWithNull = 'trace-id\x00payload';
    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-request-id': idWithNull },
    });

    const id = res.headers['x-request-id'] as string;
    expect(id).not.toBe(idWithNull);
    expect(id).toMatch(UUID_V4_REGEX);
    await app.close();
  });

  it('accepts X-Request-ID at exactly max length (256)', async () => {
    const app = await buildApp();
    const exactId = 'a'.repeat(256);
    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-request-id': exactId },
    });

    expect(res.headers['x-request-id']).toBe(exactId);
    expect(res.json().correlationId).toBe(exactId);
    await app.close();
  });
});
