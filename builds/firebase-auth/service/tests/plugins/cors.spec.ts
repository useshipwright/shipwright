import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import corsPlugin from '../../src/plugins/cors.js';

describe('cors plugin', () => {
  let savedCorsOrigin: string | undefined;
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedCorsOrigin = process.env.CORS_ORIGIN;
    savedNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (savedCorsOrigin !== undefined) {
      process.env.CORS_ORIGIN = savedCorsOrigin;
    } else {
      delete process.env.CORS_ORIGIN;
    }
    if (savedNodeEnv !== undefined) {
      process.env.NODE_ENV = savedNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  it('allows requests when CORS_ORIGIN is not set', async () => {
    delete process.env.CORS_ORIGIN;
    process.env.NODE_ENV = 'test';

    const app = Fastify({ logger: false });
    await app.register(corsPlugin);
    app.get('/test', async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { origin: 'http://example.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeDefined();
    await app.close();
  });

  it('logs warning in production mode without CORS_ORIGIN', async () => {
    delete process.env.CORS_ORIGIN;
    process.env.NODE_ENV = 'production';

    const app = Fastify({ logger: false });
    const mockWarn = vi.fn();
    app.log.warn = mockWarn;

    await app.register(corsPlugin);
    await app.ready();

    expect(mockWarn).toHaveBeenCalledWith(
      'CORS_ORIGIN is not set; allowing all origins in production',
    );
    await app.close();
  });

  it('does not log warning in non-production mode without CORS_ORIGIN', async () => {
    delete process.env.CORS_ORIGIN;
    process.env.NODE_ENV = 'test';

    const app = Fastify({ logger: false });
    const mockWarn = vi.fn();
    app.log.warn = mockWarn;

    await app.register(corsPlugin);
    await app.ready();

    expect(mockWarn).not.toHaveBeenCalled();
    await app.close();
  });

  it('uses configured CORS_ORIGIN value', async () => {
    process.env.CORS_ORIGIN = 'http://allowed.example.com';
    process.env.NODE_ENV = 'test';

    const app = Fastify({ logger: false });
    await app.register(corsPlugin);
    app.get('/test', async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { origin: 'http://allowed.example.com' },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
