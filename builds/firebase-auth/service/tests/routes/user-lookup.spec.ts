import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildRouteTestApp, type MockFirebaseAuth } from '../helpers/build-test-app.js';
import userLookupRoute from '../../src/routes/user-lookup.js';

function makeUserRecord(overrides: Record<string, unknown> = {}) {
  return {
    uid: 'user-abc-123',
    email: 'alice@example.com',
    emailVerified: true,
    displayName: 'Alice Smith',
    photoURL: 'https://example.com/alice.jpg',
    phoneNumber: '+15551234567',
    disabled: false,
    customClaims: { role: 'admin' },
    providerData: [
      {
        providerId: 'google.com',
        uid: 'google-uid-123',
        email: 'alice@gmail.com',
        displayName: 'Alice G',
        photoURL: 'https://google.com/alice.jpg',
      },
    ],
    metadata: {
      creationTime: '2024-01-01T00:00:00Z',
      lastSignInTime: '2024-02-15T12:00:00Z',
      lastRefreshTime: '2024-02-15T12:30:00Z',
    },
    ...overrides,
  };
}

function makeFirebaseError(code: string): Error {
  const err = new Error(code);
  (err as Record<string, unknown>).code = code;
  return err;
}

describe('GET /user-lookup/:uid', () => {
  let app: FastifyInstance;
  let mocks: MockFirebaseAuth;

  beforeEach(async () => {
    const testApp = await buildRouteTestApp(userLookupRoute);
    app = testApp.app;
    mocks = testApp.mocks;
  });

  afterEach(async () => {
    await app.close();
  });

  // --- Success cases ---

  describe('valid UID lookup', () => {
    it('returns 200 with full user profile', async () => {
      mocks.getUser.mockResolvedValue(makeUserRecord());

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/user-abc-123',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.uid).toBe('user-abc-123');
      expect(body.email).toBe('alice@example.com');
      expect(body.email_verified).toBe(true);
      expect(body.display_name).toBe('Alice Smith');
      expect(body.photo_url).toBe('https://example.com/alice.jpg');
      expect(body.phone_number).toBe('+15551234567');
      expect(body.disabled).toBe(false);
      expect(body.custom_claims).toEqual({ role: 'admin' });
    });

    it('returns provider_data array', async () => {
      mocks.getUser.mockResolvedValue(makeUserRecord());

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/user-abc-123',
      });

      const body = JSON.parse(res.body);
      expect(body.provider_data).toHaveLength(1);
      expect(body.provider_data[0]).toEqual({
        provider_id: 'google.com',
        uid: 'google-uid-123',
        email: 'alice@gmail.com',
        display_name: 'Alice G',
        photo_url: 'https://google.com/alice.jpg',
      });
    });

    it('returns metadata timestamps', async () => {
      mocks.getUser.mockResolvedValue(makeUserRecord());

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/user-abc-123',
      });

      const body = JSON.parse(res.body);
      expect(body.metadata).toEqual({
        creation_time: '2024-01-01T00:00:00Z',
        last_sign_in_time: '2024-02-15T12:00:00Z',
        last_refresh_time: '2024-02-15T12:30:00Z',
      });
    });

    it('returns null for missing optional fields', async () => {
      mocks.getUser.mockResolvedValue(makeUserRecord({
        email: undefined,
        displayName: undefined,
        photoURL: undefined,
        phoneNumber: undefined,
        customClaims: undefined,
      }));

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/user-abc-123',
      });

      const body = JSON.parse(res.body);
      expect(body.email).toBeNull();
      expect(body.display_name).toBeNull();
      expect(body.photo_url).toBeNull();
      expect(body.phone_number).toBeNull();
      expect(body.custom_claims).toBeNull();
    });

    it('returns disabled: true for disabled user', async () => {
      mocks.getUser.mockResolvedValue(makeUserRecord({ disabled: true }));

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/user-abc-123',
      });

      const body = JSON.parse(res.body);
      expect(body.disabled).toBe(true);
    });

    it('returns multiple providers in provider_data', async () => {
      mocks.getUser.mockResolvedValue(makeUserRecord({
        providerData: [
          { providerId: 'google.com', uid: 'g-123', email: 'a@g.com', displayName: null, photoURL: null },
          { providerId: 'apple.com', uid: 'a-456', email: null, displayName: 'Alice A', photoURL: null },
        ],
      }));

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/user-abc-123',
      });

      const body = JSON.parse(res.body);
      expect(body.provider_data).toHaveLength(2);
      expect(body.provider_data[0].provider_id).toBe('google.com');
      expect(body.provider_data[1].provider_id).toBe('apple.com');
    });

    it('returns empty provider_data array when no providers', async () => {
      mocks.getUser.mockResolvedValue(makeUserRecord({ providerData: [] }));

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/user-abc-123',
      });

      const body = JSON.parse(res.body);
      expect(body.provider_data).toEqual([]);
    });

    it('returns null last_refresh_time when not available', async () => {
      mocks.getUser.mockResolvedValue(makeUserRecord({
        metadata: {
          creationTime: '2024-01-01T00:00:00Z',
          lastSignInTime: '2024-02-15T12:00:00Z',
          lastRefreshTime: undefined,
        },
      }));

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/user-abc-123',
      });

      const body = JSON.parse(res.body);
      expect(body.metadata.last_refresh_time).toBeNull();
    });
  });

  // --- passwordHash/passwordSalt stripping (threat model) ---

  describe('passwordHash/passwordSalt stripping', () => {
    it('NEVER includes passwordHash in response', async () => {
      mocks.getUser.mockResolvedValue(makeUserRecord({
        passwordHash: 'secret-hash-value',
        passwordSalt: 'secret-salt-value',
      }));

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/user-abc-123',
      });

      expect(res.statusCode).toBe(200);
      const body = res.body;
      expect(body).not.toContain('passwordHash');
      expect(body).not.toContain('passwordSalt');
      expect(body).not.toContain('secret-hash-value');
      expect(body).not.toContain('secret-salt-value');
    });

    it('response body only contains allowlisted fields', async () => {
      mocks.getUser.mockResolvedValue(makeUserRecord({
        passwordHash: 'hash',
        passwordSalt: 'salt',
        tokensValidAfterTime: '2024-01-01',
        tenantId: 'test-tenant',
      }));

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/user-abc-123',
      });

      const body = JSON.parse(res.body);
      const allowedKeys = [
        'uid', 'email', 'email_verified', 'display_name', 'photo_url',
        'phone_number', 'disabled', 'custom_claims', 'provider_data', 'metadata',
      ];
      for (const key of Object.keys(body)) {
        expect(allowedKeys).toContain(key);
      }
    });
  });

  // --- Error cases ---

  describe('error responses', () => {
    it('returns 404 for unknown UID (auth/user-not-found)', async () => {
      mocks.getUser.mockRejectedValue(makeFirebaseError('auth/user-not-found'));

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/unknown-uid-999',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Not Found');
      expect(body.statusCode).toBe(404);
    });

    it('returns 500 for auth/internal-error', async () => {
      mocks.getUser.mockRejectedValue(makeFirebaseError('auth/internal-error'));

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/user-abc-123',
      });

      expect(res.statusCode).toBe(500);
    });

    it('returns 500 for app/invalid-credential', async () => {
      mocks.getUser.mockRejectedValue(makeFirebaseError('app/invalid-credential'));

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/user-abc-123',
      });

      expect(res.statusCode).toBe(500);
    });
  });

  // --- UID input validation (400) ---

  describe('UID input validation', () => {
    it('rejects UID exceeding max param length', async () => {
      // Fastify's find-my-way router has maxParamLength=100 by default,
      // so very long UIDs return 404 (route doesn't match) rather than 400.
      const longUid = 'a'.repeat(129);

      const res = await app.inject({
        method: 'GET',
        url: `/user-lookup/${longUid}`,
      });

      expect([400, 404]).toContain(res.statusCode);
      expect(mocks.getUser).not.toHaveBeenCalled();
    });

    it('accepts UID within router param length limit', async () => {
      // Fastify default maxParamLength is 100; test at that boundary.
      const uid = 'a'.repeat(99);
      mocks.getUser.mockResolvedValue(makeUserRecord({ uid }));

      const res = await app.inject({
        method: 'GET',
        url: `/user-lookup/${uid}`,
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 400 for UID with spaces', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/has%20space',
      });

      expect(res.statusCode).toBe(400);
      expect(mocks.getUser).not.toHaveBeenCalled();
    });

    it('returns 400 for UID with special characters', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/user@invalid',
      });

      expect(res.statusCode).toBe(400);
      expect(mocks.getUser).not.toHaveBeenCalled();
    });

    it('accepts UID with hyphens and underscores', async () => {
      mocks.getUser.mockResolvedValue(makeUserRecord({ uid: 'user_abc-123' }));

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/user_abc-123',
      });

      expect(res.statusCode).toBe(200);
    });

    it('accepts UID with only hyphens and underscores', async () => {
      mocks.getUser.mockResolvedValue(makeUserRecord({ uid: '----____' }));

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/----____',
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // --- X-Request-ID ---

  describe('correlation ID', () => {
    it('returns X-Request-ID response header', async () => {
      mocks.getUser.mockResolvedValue(makeUserRecord());

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/user-abc-123',
      });

      expect(res.headers['x-request-id']).toBeDefined();
    });
  });

  // --- Response schema conformance ---

  describe('response schema conformance', () => {
    it('200 response has all required fields', async () => {
      mocks.getUser.mockResolvedValue(makeUserRecord());

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/user-abc-123',
      });

      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('uid');
      expect(body).toHaveProperty('email_verified');
      expect(body).toHaveProperty('disabled');
      expect(body).toHaveProperty('provider_data');
      expect(body).toHaveProperty('metadata');
      expect(body.metadata).toHaveProperty('creation_time');
      expect(body.metadata).toHaveProperty('last_sign_in_time');
    });

    it('404 response has error and statusCode', async () => {
      mocks.getUser.mockRejectedValue(makeFirebaseError('auth/user-not-found'));

      const res = await app.inject({
        method: 'GET',
        url: '/user-lookup/unknown-uid',
      });

      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('statusCode');
      expect(body.statusCode).toBe(404);
    });
  });
});
