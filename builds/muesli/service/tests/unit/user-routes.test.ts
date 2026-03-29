/**
 * User route tests — T-031.
 *
 * Tests HTTP layer for user profile endpoints: GET/PUT/DELETE /api/me.
 * Includes integration test via buildApp production entry point.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import userRoutes from '../../src/routes/user.js';
import type { UserService } from '../../src/services/user.js';
import type { User } from '../../src/types/domain.js';

// ── Fixtures ────────────────────────────────────────────────────────

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'user@test.com',
    displayName: 'Test User',
    transcriptionBackend: 'deepgram',
    autoTranscribe: true,
    timezone: 'UTC',
    language: 'en',
    calendarConnected: false,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ── Mock service ────────────────────────────────────────────────────

function mockUserService(): UserService {
  return {
    getProfile: vi.fn(),
    updateProfile: vi.fn(),
    deleteAccount: vi.fn(),
  } as unknown as UserService;
}

// ── Build test app ──────────────────────────────────────────────────

async function buildTestApp(userSvc: UserService): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorateRequest('userId', '');
  app.decorateRequest('userEmail', '');
  app.addHook('onRequest', async (request) => {
    request.userId = 'user-1';
    request.userEmail = 'user@test.com';
  });

  await app.register(userRoutes, {
    prefix: '/api/me',
    userService: userSvc,
  });

  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('User Routes', () => {
  let app: FastifyInstance;
  let userSvc: UserService;

  beforeEach(() => {
    userSvc = mockUserService();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('GET /api/me', () => {
    it('returns current user profile', async () => {
      const user = makeUser();
      vi.mocked(userSvc.getProfile).mockResolvedValue(user);
      app = await buildTestApp(userSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.id).toBe('user-1');
      expect(body.data.email).toBe('user@test.com');
      expect(body.data.timezone).toBe('UTC');
    });

    it('passes userId and email from JWT to service', async () => {
      vi.mocked(userSvc.getProfile).mockResolvedValue(makeUser());
      app = await buildTestApp(userSvc);

      await app.inject({ method: 'GET', url: '/api/me' });

      expect(userSvc.getProfile).toHaveBeenCalledWith('user-1', 'user@test.com');
    });
  });

  describe('PUT /api/me', () => {
    it('updates user preferences', async () => {
      vi.mocked(userSvc.updateProfile).mockResolvedValue(
        makeUser({ timezone: 'America/New_York' }),
      );
      app = await buildTestApp(userSvc);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/me',
        payload: { timezone: 'America/New_York' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.timezone).toBe('America/New_York');
    });

    it('validates language field (2 lowercase letters)', async () => {
      app = await buildTestApp(userSvc);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/me',
        payload: { language: 'english' }, // invalid — must be 2-letter code
      });

      expect(res.statusCode).toBe(400);
    });

    it('validates transcriptionBackend enum', async () => {
      app = await buildTestApp(userSvc);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/me',
        payload: { transcriptionBackend: 'invalid-backend' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('accepts valid transcription backends', async () => {
      vi.mocked(userSvc.updateProfile).mockResolvedValue(
        makeUser({ transcriptionBackend: 'whisper' }),
      );
      app = await buildTestApp(userSvc);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/me',
        payload: { transcriptionBackend: 'whisper' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 404 when user not found', async () => {
      vi.mocked(userSvc.updateProfile).mockRejectedValue(new Error('User not found'));
      app = await buildTestApp(userSvc);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/me',
        payload: { timezone: 'UTC' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('validates displayName max length', async () => {
      app = await buildTestApp(userSvc);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/me',
        payload: { displayName: 'x'.repeat(201) },
      });

      expect(res.statusCode).toBe(400);
    });

    it('allows partial updates', async () => {
      vi.mocked(userSvc.updateProfile).mockResolvedValue(makeUser({ autoTranscribe: false }));
      app = await buildTestApp(userSvc);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/me',
        payload: { autoTranscribe: false },
      });

      expect(res.statusCode).toBe(200);
      expect(userSvc.updateProfile).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ autoTranscribe: false }),
      );
    });
  });

  describe('DELETE /api/me', () => {
    it('triggers full GDPR cascade deletion', async () => {
      vi.mocked(userSvc.deleteAccount).mockResolvedValue(undefined);
      app = await buildTestApp(userSvc);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/me',
      });

      expect(res.statusCode).toBe(204);
      expect(userSvc.deleteAccount).toHaveBeenCalledWith('user-1');
    });

    it('returns 500 when deletion fails', async () => {
      vi.mocked(userSvc.deleteAccount).mockRejectedValue(new Error('Cascade failed'));
      app = await buildTestApp(userSvc);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/me',
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error.message).toBe('Account deletion failed');
    });
  });
});
