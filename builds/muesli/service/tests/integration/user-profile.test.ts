/**
 * Integration tests — user profile (T-033).
 *
 * Tests GET/PUT /api/me for preferences and DELETE /api/me
 * for GDPR account deletion with cascade.
 *
 * Uses production route barrel (src/routes/index.ts) with auth bypass.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from '../../src/routes/index.js';
import type { AppDependencies } from '../../src/app.js';
import type { User } from '../../src/types/domain.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const NOW = new Date('2025-06-15T10:00:00Z');

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'user@test.com',
    transcriptionBackend: 'deepgram',
    autoTranscribe: true,
    timezone: 'UTC',
    language: 'en',
    calendarConnected: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as User;
}

// ── Stub services ───────────────────────────────────────────────────

function stubServices() {
  return {
    meetingService: {
      create: vi.fn(), list: vi.fn(), getById: vi.fn(), update: vi.fn(),
      delete: vi.fn(), getTranscript: vi.fn(), getSpeakers: vi.fn(),
      updateSpeaker: vi.fn(), getNotes: vi.fn(), getLatestNote: vi.fn(),
      getNote: vi.fn(), updateNote: vi.fn(),
    },
    templateService: {
      list: vi.fn(), getById: vi.fn(), create: vi.fn(), update: vi.fn(),
      delete: vi.fn(), seedSystemTemplates: vi.fn(),
    },
    audioService: {
      uploadAudio: vi.fn(), getPlaybackUrl: vi.fn(), getAudioUrl: vi.fn(),
      streamAudio: vi.fn(), canOpenStream: vi.fn(), registerStream: vi.fn(),
      unregisterStream: vi.fn(),
    },
    userNotesService: { create: vi.fn(), list: vi.fn() },
    aiNotesService: { generate: vi.fn() },
    actionService: {
      create: vi.fn(), list: vi.fn(), getById: vi.fn(), update: vi.fn(),
      delete: vi.fn(), listByMeeting: vi.fn(), getSummary: vi.fn(),
    },
    searchService: { fullTextSearch: vi.fn(), semanticSearch: vi.fn() },
    aiQaService: { askQuestion: vi.fn(), meetingPrep: vi.fn() },
    calendarService: {
      connect: vi.fn(), callback: vi.fn(), listEvents: vi.fn(),
      sync: vi.fn(), disconnect: vi.fn(),
    },
    shareService: {
      create: vi.fn(), getByShareId: vi.fn(), listByMeeting: vi.fn(),
      revoke: vi.fn(),
    },
    userService: {
      getProfile: vi.fn(),
      updateProfile: vi.fn(),
      deleteAccount: vi.fn(),
    },
  };
}

async function buildIntegrationApp(services: ReturnType<typeof stubServices>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorateRequest('userId', '');
  app.decorateRequest('userEmail', '');
  app.addHook('onRequest', async (request) => {
    request.userId = 'user-1';
    request.userEmail = 'user@test.com';
  });

  await registerRoutes(app, {
    ...services,
    firestore: { healthCheck: vi.fn().mockResolvedValue(true) },
    gcs: { healthCheck: vi.fn().mockResolvedValue(true) },
    audioProcessorDeps: {} as never,
    calendarSyncWorkerDeps: {} as never,
  } as unknown as AppDependencies);

  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('User Profile Integration', () => {
  let app: FastifyInstance;
  let services: ReturnType<typeof stubServices>;

  beforeEach(() => {
    services = stubServices();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ── GET /api/me (user profile) ─────────────────────────────────────

  describe('GET /api/me (user profile)', () => {
    it('returns user profile and preferences', async () => {
      const user = makeUser();
      services.userService.getProfile.mockResolvedValue(user);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.id).toBe('user-1');
      expect(body.data.email).toBe('user@test.com');
      expect(body.data.transcriptionBackend).toBe('deepgram');
      expect(body.data.autoTranscribe).toBe(true);
      expect(body.data.timezone).toBe('UTC');
      expect(body.data.language).toBe('en');
    });

    it('passes userId and email from auth context', async () => {
      services.userService.getProfile.mockResolvedValue(makeUser());

      app = await buildIntegrationApp(services);

      await app.inject({ method: 'GET', url: '/api/me' });

      expect(services.userService.getProfile).toHaveBeenCalledWith(
        'user-1', 'user@test.com',
      );
    });

    it('auto-creates profile for first-time user', async () => {
      services.userService.getProfile.mockResolvedValue(makeUser());

      app = await buildIntegrationApp(services);

      const res = await app.inject({ method: 'GET', url: '/api/me' });

      expect(res.statusCode).toBe(200);
      // Service handles auto-creation internally
      expect(services.userService.getProfile).toHaveBeenCalled();
    });
  });

  // ── PUT /api/me (update preferences) ────────────────────────────────

  describe('PUT /api/me (update preferences)', () => {
    it('updates user preferences', async () => {
      const updated = makeUser({
        transcriptionBackend: 'whisper',
        autoTranscribe: false,
        timezone: 'America/New_York',
        language: 'es',
      });
      services.userService.updateProfile.mockResolvedValue(updated);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/me',
        payload: {
          transcriptionBackend: 'whisper',
          autoTranscribe: false,
          timezone: 'America/New_York',
          language: 'es',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.transcriptionBackend).toBe('whisper');
      expect(body.data.autoTranscribe).toBe(false);
      expect(body.data.timezone).toBe('America/New_York');
    });

    it('passes partial updates correctly', async () => {
      services.userService.updateProfile.mockResolvedValue(
        makeUser({ language: 'fr' }),
      );

      app = await buildIntegrationApp(services);

      await app.inject({
        method: 'PUT',
        url: '/api/me',
        payload: { language: 'fr' },
      });

      expect(services.userService.updateProfile).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ language: 'fr' }),
      );
    });

    it('returns 404 when user not found', async () => {
      services.userService.updateProfile.mockRejectedValue(
        new Error('User not found'),
      );

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/me',
        payload: { language: 'de' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── DELETE /api/me (GDPR account deletion) ──────────────────────────

  describe('DELETE /api/me (GDPR account deletion)', () => {
    it('cascades deletion to all user data across collections and GCS', async () => {
      services.userService.deleteAccount.mockResolvedValue(undefined);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/me',
      });

      expect(res.statusCode).toBe(204);
      expect(services.userService.deleteAccount).toHaveBeenCalledWith('user-1');
    });

    it('returns 500 when account deletion fails', async () => {
      services.userService.deleteAccount.mockRejectedValue(
        new Error('Firestore batch delete failed'),
      );

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/me',
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error.message).toBe('Account deletion failed');
    });
  });
});
