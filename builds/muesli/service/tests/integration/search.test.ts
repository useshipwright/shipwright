/**
 * Integration tests — search (T-033).
 *
 * Tests full-text search via GET /api/search, semantic search via
 * GET /api/search/semantic, cursor-based pagination, and userId scoping.
 *
 * Uses production route barrel (src/routes/index.ts) with auth bypass.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from '../../src/routes/index.js';
import { buildTestApp } from '../helpers/setup.js';
import type { AppDependencies } from '../../src/app.js';

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
      getProfile: vi.fn(), updatePreferences: vi.fn(), deleteAccount: vi.fn(),
    },
  };
}

async function buildIntegrationApp(
  services: ReturnType<typeof stubServices>,
  userId = 'user-1',
  userEmail = 'user@test.com',
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorateRequest('userId', '');
  app.decorateRequest('userEmail', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userEmail = userEmail;
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

describe('Search Integration', () => {
  let app: FastifyInstance;
  let services: ReturnType<typeof stubServices>;

  beforeEach(() => {
    services = stubServices();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ── Production entry point test ─────────────────────────────────
  it('search route is wired through production buildApp entry point', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/search?q=test' });
    // Should not 404 — route is registered
    expect(res.statusCode).not.toBe(404);
  });

  // ── Full-text search ────────────────────────────────────────────

  describe('GET /api/search (full-text)', () => {
    it('searches meetings, notes, transcripts, and actions', async () => {
      services.searchService.fullTextSearch.mockResolvedValue({
        meetings: [
          { id: 'm1', title: 'Sprint Planning', type: 'meeting' },
          { id: 'm2', title: 'Sprint Review', type: 'meeting' },
        ],
        actions: [
          { id: 'a1', title: 'Review sprint backlog', type: 'action' },
        ],
        cursor: undefined,
        hasMore: false,
      });

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/search?q=sprint',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.meetings).toHaveLength(2);
      expect(body.data.actions).toHaveLength(1);
      expect(body.meta.hasMore).toBe(false);
    });

    it('passes type filter to service', async () => {
      services.searchService.fullTextSearch.mockResolvedValue({
        meetings: [], actions: [], hasMore: false,
      });

      app = await buildIntegrationApp(services);

      await app.inject({ method: 'GET', url: '/api/search?q=test&type=meetings' });

      expect(services.searchService.fullTextSearch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'meetings' }),
      );
    });

    it('scopes search to authenticated user', async () => {
      services.searchService.fullTextSearch.mockResolvedValue({
        meetings: [], actions: [], hasMore: false,
      });

      app = await buildIntegrationApp(services);

      await app.inject({ method: 'GET', url: '/api/search?q=test' });

      expect(services.searchService.fullTextSearch).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('supports cursor-based pagination', async () => {
      services.searchService.fullTextSearch.mockResolvedValue({
        meetings: [{ id: 'm3', title: 'Page 2 result', type: 'meeting' }],
        actions: [],
        cursor: 'next-cursor',
        hasMore: true,
      });

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&cursor=prev-cursor&limit=10',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.meta.cursor).toBe('next-cursor');
      expect(body.meta.hasMore).toBe(true);

      expect(services.searchService.fullTextSearch).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: 'prev-cursor', limit: 10 }),
      );
    });

    it('returns empty results for no matches', async () => {
      services.searchService.fullTextSearch.mockResolvedValue({
        meetings: [], actions: [], hasMore: false,
      });

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/search?q=nonexistent',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.meetings).toHaveLength(0);
      expect(body.data.actions).toHaveLength(0);
    });
  });

  // ── Semantic search ─────────────────────────────────────────────

  describe('GET /api/search/semantic', () => {
    it('performs vector similarity search with embedding generation', async () => {
      services.searchService.semanticSearch.mockResolvedValue({
        results: [
          { id: 'e1', meetingId: 'm1', content: 'Sprint discussion', similarity: 0.92, sourceType: 'note' },
          { id: 'e2', meetingId: 'm2', content: 'Sprint review', similarity: 0.85, sourceType: 'transcript' },
        ],
      });

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/search/semantic?q=sprint+progress',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].similarity).toBe(0.92);
    });

    it('scopes semantic search to authenticated user', async () => {
      services.searchService.semanticSearch.mockResolvedValue({ results: [] });

      app = await buildIntegrationApp(services);

      await app.inject({ method: 'GET', url: '/api/search/semantic?q=test' });

      expect(services.searchService.semanticSearch).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('returns 503 when embedding adapter fails', async () => {
      services.searchService.semanticSearch.mockRejectedValue(
        new Error('Embedding service unavailable'),
      );

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/search/semantic?q=test',
      });

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error.message).toContain('Embedding');
    });

    it('passes filters to semantic search', async () => {
      services.searchService.semanticSearch.mockResolvedValue({ results: [] });

      app = await buildIntegrationApp(services);

      await app.inject({
        method: 'GET',
        url: '/api/search/semantic?q=test&meetingId=m1&source=notes&limit=5',
      });

      expect(services.searchService.semanticSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'test',
          limit: 5,
          filters: expect.objectContaining({ meetingId: 'm1', sourceType: 'notes' }),
        }),
      );
    });
  });

  // ── Cross-user isolation ────────────────────────────────────────

  describe('userId scoping prevents cross-user data leakage', () => {
    it('user-2 search does not return user-1 data', async () => {
      services.searchService.fullTextSearch.mockResolvedValue({
        meetings: [], actions: [], hasMore: false,
      });

      app = await buildIntegrationApp(services, 'user-2');

      await app.inject({ method: 'GET', url: '/api/search?q=sprint' });

      expect(services.searchService.fullTextSearch).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-2' }),
      );
    });
  });
});
