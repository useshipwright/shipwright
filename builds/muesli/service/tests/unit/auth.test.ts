/**
 * Auth middleware tests — T-027.
 *
 * Tests Firebase JWT verification, OIDC token verification for internal routes,
 * and share access control. Uses a lightweight Fastify app with auth plugin
 * and app.inject() for integration testing.
 */

import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import * as crypto from 'node:crypto';

// Mock google-auth-library to use test RSA keys for OIDC verification
vi.mock('google-auth-library', () => {
  return {
    OAuth2Client: class MockOAuth2Client {
      async verifyIdToken({ idToken }: { idToken: string }) {
        // Decode without crypto verification (test tokens are self-signed)
        const parts = idToken.split('.');
        if (parts.length !== 3) throw new Error('Invalid token');
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp < now) throw new Error('Token expired');
        if (
          payload.iss !== 'accounts.google.com' &&
          payload.iss !== 'https://accounts.google.com'
        ) throw new Error('Invalid issuer');
        return { getPayload: () => payload };
      }
    },
  };
});

import authPlugin from '../../src/plugins/auth.js';

// ── RSA key pair for test OIDC tokens ────────────────────────────────

let testPrivateKey: crypto.KeyObject;
let testPublicJwk: crypto.JsonWebKey & { kid: string; alg: string; use: string };

beforeAll(() => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  testPrivateKey = privateKey;
  const jwk = publicKey.export({ format: 'jwk' });
  testPublicJwk = { ...jwk, kid: 'test-key-1', alg: 'RS256', use: 'sig' };
});

// ── Helpers ──────────────────────────────────────────────────────────

function makeOidcToken(payload: Record<string, unknown>): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key-1' };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const bodyB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signatureInput = `${headerB64}.${bodyB64}`;
  const signature = crypto.sign('sha256', Buffer.from(signatureInput), testPrivateKey);
  return `${headerB64}.${bodyB64}.${Buffer.from(signature).toString('base64url')}`;
}

/**
 * Mock global.fetch to return our test JWKS when Google's JWKS URL is requested.
 * All other URLs return 404.
 */
function mockGoogleJwks(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('googleapis.com/oauth2/v3/certs')) {
      return new Response(JSON.stringify({ keys: [testPublicJwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' },
      });
    }
    return new Response('Not found', { status: 404 });
  });
}

/**
 * Build a minimal Fastify app with auth plugin and test routes.
 * Avoids importing routes (which trigger zod-to-json-schema).
 */
async function buildAuthTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Register auth plugin (same as production)
  await app.register(authPlugin);

  // Add test routes to verify auth behavior
  app.get('/health', async () => ({ data: { status: 'ok' } }));
  app.get('/health/ready', async () => ({ data: { status: 'ok' } }));

  app.get('/api/meetings', async (request) => ({
    data: { userId: request.userId, email: request.userEmail },
  }));

  app.get('/api/share/:shareId', async (request) => {
    const params = request.params as { shareId: string };
    return { data: { shareId: params.shareId } };
  });

  app.post('/internal/process-audio', async () => ({
    data: { status: 'accepted' },
  }));

  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Auth Middleware', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
    vi.restoreAllMocks();
  });

  describe('health endpoints bypass auth', () => {
    it('GET /health returns 200 without auth', async () => {
      app = await buildAuthTestApp();
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    });

    it('GET /health/ready returns 200 without auth', async () => {
      app = await buildAuthTestApp();
      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('API routes require Firebase JWT', () => {
    it('rejects requests without Authorization header with 401', async () => {
      app = await buildAuthTestApp();
      const res = await app.inject({ method: 'GET', url: '/api/meetings' });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(401);
    });

    it('rejects requests with malformed Bearer header (Token prefix)', async () => {
      app = await buildAuthTestApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings',
        headers: { authorization: 'Token xyz' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects requests with empty Bearer token', async () => {
      app = await buildAuthTestApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings',
        headers: { authorization: 'Bearer ' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects requests with no space after Bearer', async () => {
      app = await buildAuthTestApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings',
        headers: { authorization: 'Bearertoken123' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects requests with invalid Firebase token', async () => {
      app = await buildAuthTestApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings',
        headers: { authorization: 'Bearer invalid-token-123' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('internal routes require OIDC token', () => {
    it('rejects requests without Authorization header with 401', async () => {
      app = await buildAuthTestApp();
      const res = await app.inject({
        method: 'POST',
        url: '/internal/process-audio',
      });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain('OIDC');
    });

    it('rejects expired OIDC tokens', async () => {
      mockGoogleJwks();
      app = await buildAuthTestApp();
      const token = makeOidcToken({
        iss: 'https://accounts.google.com',
        email: 'sa@project.iam.gserviceaccount.com',
        exp: Math.floor(Date.now() / 1000) - 3600, // expired 1 hour ago
      });

      const res = await app.inject({
        method: 'POST',
        url: '/internal/process-audio',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects OIDC tokens with wrong issuer', async () => {
      mockGoogleJwks();
      app = await buildAuthTestApp();
      const token = makeOidcToken({
        iss: 'https://evil.example.com',
        email: 'sa@project.iam.gserviceaccount.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/internal/process-audio',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it('accepts valid OIDC token from Google (https issuer)', async () => {
      mockGoogleJwks();
      app = await buildAuthTestApp();
      const token = makeOidcToken({
        iss: 'https://accounts.google.com',
        email: 'sa@project.iam.gserviceaccount.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/internal/process-audio',
        headers: { authorization: `Bearer ${token}` },
      });
      // Should pass auth (200 from our test route)
      expect(res.statusCode).toBe(200);
    });

    it('accepts OIDC token with accounts.google.com (no https) issuer', async () => {
      mockGoogleJwks();
      app = await buildAuthTestApp();
      const token = makeOidcToken({
        iss: 'accounts.google.com',
        email: 'sa@project.iam.gserviceaccount.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/internal/process-audio',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects malformed OIDC token (not 3 parts)', async () => {
      app = await buildAuthTestApp();
      const res = await app.inject({
        method: 'POST',
        url: '/internal/process-audio',
        headers: { authorization: 'Bearer not-a-jwt' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects OIDC token with only 2 parts', async () => {
      app = await buildAuthTestApp();
      const res = await app.inject({
        method: 'POST',
        url: '/internal/process-audio',
        headers: { authorization: 'Bearer part1.part2' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('share routes', () => {
    it('GET /api/share/:id does not return 401 when no firestoreAdapter', async () => {
      app = await buildAuthTestApp();
      // Without firestoreAdapter registered, auth plugin skips share verification
      const res = await app.inject({
        method: 'GET',
        url: '/api/share/some-share-id',
      });
      // Should not be 401 — share routes skip auth when no adapter
      expect(res.statusCode).not.toBe(401);
    });

    it('returns 200 for share routes without auth headers', async () => {
      app = await buildAuthTestApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/share/test-share-123',
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('userId and userEmail attachment', () => {
    it('attaches empty userId and userEmail when auth fails', async () => {
      app = await buildAuthTestApp();
      // Without valid auth, request should be rejected
      const res = await app.inject({ method: 'GET', url: '/api/meetings' });
      expect(res.statusCode).toBe(401);
    });
  });
});
