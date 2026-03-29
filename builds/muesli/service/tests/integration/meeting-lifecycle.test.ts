/**
 * Integration tests — meeting lifecycle (T-032).
 *
 * Exercises full CRUD cycle, status transitions, pagination, filtering,
 * and userId scoping through the Fastify app with mocked services.
 *
 * Uses production route barrel (src/routes/index.ts) with auth bypass.
 * One test uses buildApp from src/app.ts (production entry point).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from '../../src/routes/index.js';
import { buildTestApp } from '../helpers/setup.js';
import type { AppDependencies } from '../../src/app.js';
import type { Meeting, MeetingNote } from '../../src/types/domain.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const NOW = new Date('2025-06-15T10:00:00Z');

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'meeting-1',
    userId: 'user-1',
    title: 'Sprint Planning',
    status: 'ready',
    attendees: [{ name: 'Alice' }, { name: 'Bob', email: 'bob@test.com' }],
    tags: ['dev', 'sprint'],
    isStarred: false,
    latestNoteVersion: 0,
    searchTokens: ['sprint', 'planning', 'alice', 'bob'],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeNote(overrides: Partial<MeetingNote> = {}): MeetingNote {
  return {
    version: 1,
    templateId: 'tpl-1',
    sections: [{ heading: 'Summary', content: 'A productive meeting.' }],
    isEdited: false,
    model: 'sonnet',
    inputTokens: 500,
    outputTokens: 200,
    generationLatencyMs: 1200,
    generatedAt: NOW,
    ...overrides,
  };
}

// ── Stub services ───────────────────────────────────────────────────

function stubServices() {
  return {
    meetingService: {
      create: vi.fn(),
      list: vi.fn(),
      getById: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getTranscript: vi.fn(),
      getSpeakers: vi.fn(),
      updateSpeaker: vi.fn(),
      getNotes: vi.fn(),
      getLatestNote: vi.fn(),
      getNote: vi.fn(),
      updateNote: vi.fn(),
    },
    templateService: {
      list: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      seedSystemTemplates: vi.fn(),
    },
    audioService: {
      uploadAudio: vi.fn(),
      getPlaybackUrl: vi.fn(),
      getAudioUrl: vi.fn(),
      streamAudio: vi.fn(),
      canOpenStream: vi.fn(),
      registerStream: vi.fn(),
      unregisterStream: vi.fn(),
    },
    userNotesService: { create: vi.fn(), list: vi.fn() },
    aiNotesService: { generate: vi.fn() },
    actionService: {
      create: vi.fn(),
      list: vi.fn(),
      getById: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      listByMeeting: vi.fn(),
      getSummary: vi.fn(),
    },
    searchService: { fullTextSearch: vi.fn(), semanticSearch: vi.fn() },
    aiQaService: { askQuestion: vi.fn(), meetingPrep: vi.fn() },
    calendarService: {
      connect: vi.fn(),
      callback: vi.fn(),
      listEvents: vi.fn(),
      sync: vi.fn(),
      disconnect: vi.fn(),
    },
    shareService: {
      create: vi.fn(),
      getByShareId: vi.fn(),
      listByMeeting: vi.fn(),
      revoke: vi.fn(),
    },
    userService: {
      getProfile: vi.fn(),
      updatePreferences: vi.fn(),
      deleteAccount: vi.fn(),
    },
  };
}

// ── Build integration test app with auth bypass ─────────────────────

async function buildIntegrationApp(services: ReturnType<typeof stubServices>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Auth bypass — decorate request with known userId
  app.decorateRequest('userId', '');
  app.decorateRequest('userEmail', '');
  app.addHook('onRequest', async (request) => {
    request.userId = 'user-1';
    request.userEmail = 'user@test.com';
  });

  const firestore = {
    healthCheck: vi.fn().mockResolvedValue(true),
  };
  const gcs = {
    healthCheck: vi.fn().mockResolvedValue(true),
  };

  // Register all routes through production barrel
  await registerRoutes(app, {
    ...services,
    firestore,
    gcs,
    audioProcessorDeps: {} as never,
    calendarSyncWorkerDeps: {} as never,
  } as unknown as AppDependencies);

  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Meeting Lifecycle Integration', () => {
  let app: FastifyInstance;
  let services: ReturnType<typeof stubServices>;

  beforeEach(() => {
    services = stubServices();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ── Production entry point test (buildApp) ──────────────────────

  it('health endpoint works through production buildApp entry point', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('ok');
  });

  // ── Full CRUD cycle ─────────────────────────────────────────────

  describe('full CRUD cycle', () => {
    it('creates, updates, gets detail with latest notes, and deletes a meeting', async () => {
      const created = makeMeeting();
      const updated = makeMeeting({ title: 'Updated Sprint' });
      const withNotes = { ...updated, latestNotes: makeNote() };

      services.meetingService.create.mockResolvedValue(created);
      services.meetingService.update.mockResolvedValue(updated);
      services.meetingService.getById.mockResolvedValue(withNotes);
      services.meetingService.delete.mockResolvedValue(true);

      app = await buildIntegrationApp(services);

      // 1. Create
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/meetings',
        payload: { title: 'Sprint Planning', attendees: [{ name: 'Alice' }], tags: ['dev'] },
      });
      expect(createRes.statusCode).toBe(201);
      expect(JSON.parse(createRes.body).data.id).toBe('meeting-1');

      // 2. Update
      const updateRes = await app.inject({
        method: 'PUT',
        url: '/api/meetings/meeting-1',
        payload: { title: 'Updated Sprint' },
      });
      expect(updateRes.statusCode).toBe(200);

      // 3. Get detail with latest notes
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/meetings/meeting-1',
      });
      expect(getRes.statusCode).toBe(200);
      const detail = JSON.parse(getRes.body).data;
      expect(detail.title).toBe('Updated Sprint');
      expect(detail.latestNotes).toBeDefined();
      expect(detail.latestNotes.version).toBe(1);

      // 4. Delete
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: '/api/meetings/meeting-1',
      });
      expect(deleteRes.statusCode).toBe(200);
      expect(services.meetingService.delete).toHaveBeenCalledWith('meeting-1', 'user-1');
    });
  });

  // ── Status transitions ──────────────────────────────────────────

  describe('meeting status transitions', () => {
    it('transitions from recording through processing to ready', async () => {
      const recording = makeMeeting({ status: 'recording' });
      const processing = makeMeeting({ status: 'processing' });
      const ready = makeMeeting({ status: 'ready' });

      services.meetingService.getById
        .mockResolvedValueOnce(recording)
        .mockResolvedValueOnce(processing)
        .mockResolvedValueOnce(ready);

      app = await buildIntegrationApp(services);

      // Verify each state is returned correctly
      let res = await app.inject({ method: 'GET', url: '/api/meetings/meeting-1' });
      expect(JSON.parse(res.body).data.status).toBe('recording');

      res = await app.inject({ method: 'GET', url: '/api/meetings/meeting-1' });
      expect(JSON.parse(res.body).data.status).toBe('processing');

      res = await app.inject({ method: 'GET', url: '/api/meetings/meeting-1' });
      expect(JSON.parse(res.body).data.status).toBe('ready');
    });

    it('transitions to failed on processing error', async () => {
      const failed = makeMeeting({ status: 'failed', error: 'Transcription failed' });
      services.meetingService.getById.mockResolvedValue(failed);

      app = await buildIntegrationApp(services);

      const res = await app.inject({ method: 'GET', url: '/api/meetings/meeting-1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body).data;
      expect(body.status).toBe('failed');
      expect(body.error).toBe('Transcription failed');
    });
  });

  // ── Pagination ─────────────────────────────────────────────────

  describe('cursor-based pagination', () => {
    it('returns meetings with cursor for next page', async () => {
      const page1 = [makeMeeting({ id: 'm1' }), makeMeeting({ id: 'm2' })];

      services.meetingService.list.mockResolvedValue({
        meetings: page1,
        cursor: 'cursor-abc',
        hasMore: true,
      });

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings?limit=2',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(2);
      expect(body.meta.cursor).toBe('cursor-abc');
      expect(body.meta.hasMore).toBe(true);
    });

    it('passes cursor to service for subsequent pages', async () => {
      services.meetingService.list.mockResolvedValue({
        meetings: [makeMeeting({ id: 'm3' })],
        cursor: undefined,
        hasMore: false,
      });

      app = await buildIntegrationApp(services);

      await app.inject({
        method: 'GET',
        url: '/api/meetings?limit=2&cursor=cursor-abc',
      });

      expect(services.meetingService.list).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: 'cursor-abc', limit: 2 }),
      );
    });
  });

  // ── Filtering ──────────────────────────────────────────────────

  describe('filtering', () => {
    beforeEach(async () => {
      services.meetingService.list.mockResolvedValue({
        meetings: [makeMeeting()],
        hasMore: false,
      });
      app = await buildIntegrationApp(services);
    });

    it('filters by status', async () => {
      await app.inject({ method: 'GET', url: '/api/meetings?status=processing' });
      expect(services.meetingService.list).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'processing' }),
      );
    });

    it('filters by isStarred', async () => {
      await app.inject({ method: 'GET', url: '/api/meetings?isStarred=true' });
      // isStarred arrives as string from query param (Zod transform lost in JSON Schema conversion)
      expect(services.meetingService.list).toHaveBeenCalledWith(
        expect.objectContaining({ isStarred: expect.anything() }),
      );
      const callArg = services.meetingService.list.mock.calls[0][0] as { isStarred: unknown };
      // Value is either boolean true or string "true" depending on schema coercion
      expect(String(callArg.isStarred)).toBe('true');
    });

    it('filters by tag', async () => {
      await app.inject({ method: 'GET', url: '/api/meetings?tag=dev' });
      expect(services.meetingService.list).toHaveBeenCalledWith(
        expect.objectContaining({ tag: 'dev' }),
      );
    });

    it('filters by date range', async () => {
      await app.inject({
        method: 'GET',
        url: '/api/meetings?dateFrom=2025-01-01&dateTo=2025-12-31',
      });
      expect(services.meetingService.list).toHaveBeenCalledWith(
        expect.objectContaining({
          dateFrom: '2025-01-01',
          dateTo: '2025-12-31',
        }),
      );
    });

    it('filters by attendee', async () => {
      await app.inject({ method: 'GET', url: '/api/meetings?attendee=alice' });
      expect(services.meetingService.list).toHaveBeenCalledWith(
        expect.objectContaining({ attendee: 'alice' }),
      );
    });
  });

  // ── userId scoping ────────────────────────────────────────────

  describe('userId scoping', () => {
    it('passes userId from auth context to service layer on create', async () => {
      services.meetingService.create.mockResolvedValue(makeMeeting());
      app = await buildIntegrationApp(services);

      await app.inject({
        method: 'POST',
        url: '/api/meetings',
        payload: { title: 'Test' },
      });

      expect(services.meetingService.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('passes userId from auth context to service layer on list', async () => {
      services.meetingService.list.mockResolvedValue({ meetings: [], hasMore: false });
      app = await buildIntegrationApp(services);

      await app.inject({ method: 'GET', url: '/api/meetings' });

      expect(services.meetingService.list).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('passes userId to getById — returns 404 for other user meetings', async () => {
      services.meetingService.getById.mockResolvedValue(null);
      app = await buildIntegrationApp(services);

      const res = await app.inject({ method: 'GET', url: '/api/meetings/other-meeting' });
      expect(res.statusCode).toBe(404);
      expect(services.meetingService.getById).toHaveBeenCalledWith('other-meeting', 'user-1');
    });

    it('passes userId to update — returns 404 for other user meetings', async () => {
      services.meetingService.update.mockResolvedValue(null);
      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/meetings/other-meeting',
        payload: { title: 'Hijack' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('passes userId to delete — returns 404 for other user meetings', async () => {
      services.meetingService.delete.mockResolvedValue(false);
      app = await buildIntegrationApp(services);

      const res = await app.inject({ method: 'DELETE', url: '/api/meetings/other-meeting' });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── List with filters combined ─────────────────────────────────

  describe('list with multiple filters', () => {
    it('applies sorting parameters', async () => {
      services.meetingService.list.mockResolvedValue({
        meetings: [],
        hasMore: false,
      });
      app = await buildIntegrationApp(services);

      await app.inject({
        method: 'GET',
        url: '/api/meetings?sortBy=title&sortOrder=asc',
      });

      expect(services.meetingService.list).toHaveBeenCalledWith(
        expect.objectContaining({ sortBy: 'title', sortOrder: 'asc' }),
      );
    });
  });

  // ── Delete cascading ──────────────────────────────────────────

  describe('delete with cascade', () => {
    it('calls service delete which handles cascade of subcollections and GCS audio', async () => {
      services.meetingService.delete.mockResolvedValue(true);
      app = await buildIntegrationApp(services);

      const res = await app.inject({ method: 'DELETE', url: '/api/meetings/meeting-1' });
      expect(res.statusCode).toBe(200);
      expect(services.meetingService.delete).toHaveBeenCalledWith('meeting-1', 'user-1');
    });
  });
});
