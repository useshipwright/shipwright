import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  const { default: requestContext } = await import('../../src/plugins/request-context.js');
  await app.register(requestContext);

  // Test route that returns the requestId seen by the handler
  app.get('/echo-id', async (request) => ({
    requestId: request.requestId,
  }));

  await app.ready();
  return app;
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('request-context plugin', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // X-Request-ID propagation
  // -----------------------------------------------------------------------

  describe('X-Request-ID propagation from header', () => {
    it('uses client-provided X-Request-ID as-is', async () => {
      const clientId = 'my-custom-request-id-12345';
      const res = await app.inject({
        method: 'GET',
        url: '/echo-id',
        headers: { 'x-request-id': clientId },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().requestId).toBe(clientId);
    });

    it('echoes X-Request-ID back in response header', async () => {
      const clientId = 'correlation-abc';
      const res = await app.inject({
        method: 'GET',
        url: '/echo-id',
        headers: { 'x-request-id': clientId },
      });

      expect(res.headers['x-request-id']).toBe(clientId);
    });
  });

  // -----------------------------------------------------------------------
  // UUIDv4 generation when absent
  // -----------------------------------------------------------------------

  describe('UUIDv4 generation when absent', () => {
    it('generates a valid UUIDv4 when X-Request-ID header is missing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/echo-id',
      });

      expect(res.statusCode).toBe(200);
      const { requestId } = res.json();
      expect(requestId).toMatch(UUID_V4_RE);
    });

    it('generates a UUIDv4 when X-Request-ID header is empty', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/echo-id',
        headers: { 'x-request-id': '' },
      });

      expect(res.json().requestId).toMatch(UUID_V4_RE);
    });

    it('generates unique IDs for different requests', async () => {
      const res1 = await app.inject({ method: 'GET', url: '/echo-id' });
      const res2 = await app.inject({ method: 'GET', url: '/echo-id' });

      expect(res1.json().requestId).not.toBe(res2.json().requestId);
    });
  });

  // -----------------------------------------------------------------------
  // Response header setting
  // -----------------------------------------------------------------------

  describe('response header setting', () => {
    it('sets X-Request-ID on the response for generated IDs', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/echo-id',
      });

      const responseHeaderId = res.headers['x-request-id'];
      expect(responseHeaderId).toBeDefined();
      expect(responseHeaderId).toMatch(UUID_V4_RE);

      // response header matches the requestId in body
      expect(responseHeaderId).toBe(res.json().requestId);
    });

    it('response header matches decorated request.requestId for client-provided ID', async () => {
      const clientId = 'provided-by-client';
      const res = await app.inject({
        method: 'GET',
        url: '/echo-id',
        headers: { 'x-request-id': clientId },
      });

      expect(res.headers['x-request-id']).toBe(clientId);
      expect(res.json().requestId).toBe(clientId);
    });
  });
});
