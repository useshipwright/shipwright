import { describe, it, expect, afterEach } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { FastifyInstance } from 'fastify';

describe('GET /health', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with required fields', async () => {
    app = await buildApp({ skipFirebaseInit: true });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('firebase_initialized');
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('timestamp');
  });

  it('returns firebase_initialized: false and status: degraded when Firebase is not initialized', async () => {
    app = await buildApp({ skipFirebaseInit: true });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(res.body);

    expect(body.firebase_initialized).toBe(false);
    expect(body.status).toBe('degraded');
  });

  it('returns a valid ISO 8601 timestamp', async () => {
    app = await buildApp({ skipFirebaseInit: true });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(res.body);

    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('returns version from package.json', async () => {
    app = await buildApp({ skipFirebaseInit: true });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(res.body);

    expect(typeof body.version).toBe('string');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns X-Request-ID response header', async () => {
    app = await buildApp({ skipFirebaseInit: true });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.headers['x-request-id']).toBeDefined();
    expect(typeof res.headers['x-request-id']).toBe('string');
  });

  it('propagates X-Request-ID from request header', async () => {
    app = await buildApp({ skipFirebaseInit: true });
    await app.ready();

    const requestId = 'test-correlation-id-12345';
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': requestId },
    });

    expect(res.headers['x-request-id']).toBe(requestId);
  });

  it('does not require authentication', async () => {
    app = await buildApp({ skipFirebaseInit: true });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
  });
});
