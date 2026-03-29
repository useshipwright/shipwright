/**
 * Integration tests — action items (T-033).
 *
 * Tests CRUD lifecycle, summary aggregation, meeting-scoped listing,
 * and status/assignee filtering.
 *
 * Uses production route barrel (src/routes/index.ts) with auth bypass.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from '../../src/routes/index.js';
import type { AppDependencies } from '../../src/app.js';
import type { ActionItem } from '../../src/types/domain.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const NOW = new Date('2025-06-15T10:00:00Z');

function makeAction(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: 'action-1',
    userId: 'user-1',
    meetingId: 'meeting-1',
    title: 'Review PR #123',
    status: 'open',
    source: 'manual',
    createdAt: NOW,
    updatedAt: NOW,
    searchTokens: ['review', 'pr', '123'],
    ...overrides,
  } as ActionItem;
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

describe('Action Items Integration', () => {
  let app: FastifyInstance;
  let services: ReturnType<typeof stubServices>;

  beforeEach(() => {
    services = stubServices();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ── CRUD lifecycle ────────────────────────────────────────────────

  describe('full CRUD lifecycle', () => {
    it('creates, updates status, lists with filters, and deletes', async () => {
      const created = makeAction();
      const updated = makeAction({ status: 'in_progress' });

      services.actionService.create.mockResolvedValue(created);
      services.actionService.update.mockResolvedValue(updated);
      services.actionService.list.mockResolvedValue({
        actions: [updated],
        cursor: undefined,
        hasMore: false,
      });
      services.actionService.delete.mockResolvedValue(true);

      app = await buildIntegrationApp(services);

      // 1. Create
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/actions',
        payload: {
          title: 'Review PR #123',
          meetingId: 'meeting-1',
          assignee: 'Alice',
        },
      });
      expect(createRes.statusCode).toBe(201);
      expect(JSON.parse(createRes.body).data.id).toBe('action-1');

      // 2. Update status
      const updateRes = await app.inject({
        method: 'PUT',
        url: '/api/actions/action-1',
        payload: { status: 'in_progress' },
      });
      expect(updateRes.statusCode).toBe(200);
      expect(JSON.parse(updateRes.body).data.status).toBe('in_progress');

      // 3. List with filters
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/actions?status=in_progress',
      });
      expect(listRes.statusCode).toBe(200);
      const listBody = JSON.parse(listRes.body);
      expect(listBody.data).toHaveLength(1);
      expect(listBody.data[0].status).toBe('in_progress');

      // 4. Delete
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: '/api/actions/action-1',
      });
      expect(deleteRes.statusCode).toBe(200);
      expect(JSON.parse(deleteRes.body).data.deleted).toBe(true);
    });
  });

  // ── Create ────────────────────────────────────────────────────────

  describe('POST /api/actions', () => {
    it('passes userId from auth context', async () => {
      services.actionService.create.mockResolvedValue(makeAction());

      app = await buildIntegrationApp(services);

      await app.inject({
        method: 'POST',
        url: '/api/actions',
        payload: { title: 'Do something' },
      });

      expect(services.actionService.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
      );
    });
  });

  // ── Update ────────────────────────────────────────────────────────

  describe('PUT /api/actions/:id', () => {
    it('returns 404 for non-existent action', async () => {
      services.actionService.update.mockResolvedValue(null);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/actions/nonexistent',
        payload: { status: 'completed' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── List with filters ─────────────────────────────────────────────

  describe('GET /api/actions', () => {
    it('filters by status and assignee', async () => {
      services.actionService.list.mockResolvedValue({
        actions: [], cursor: undefined, hasMore: false,
      });

      app = await buildIntegrationApp(services);

      await app.inject({
        method: 'GET',
        url: '/api/actions?status=open&assignee=Alice',
      });

      expect(services.actionService.list).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          status: 'open',
          assignee: 'Alice',
        }),
      );
    });

    it('filters by meetingId', async () => {
      services.actionService.list.mockResolvedValue({
        actions: [], cursor: undefined, hasMore: false,
      });

      app = await buildIntegrationApp(services);

      await app.inject({
        method: 'GET',
        url: '/api/actions?meetingId=m1',
      });

      expect(services.actionService.list).toHaveBeenCalledWith(
        expect.objectContaining({
          meetingId: 'm1',
          userId: 'user-1',
        }),
      );
    });

    it('supports cursor-based pagination', async () => {
      services.actionService.list.mockResolvedValue({
        actions: [makeAction({ id: 'a2' })],
        cursor: 'next-cursor',
        hasMore: true,
      });

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/actions?cursor=prev-cursor&limit=5',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.meta.cursor).toBe('next-cursor');
      expect(body.meta.hasMore).toBe(true);

      expect(services.actionService.list).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: 'prev-cursor', limit: 5 }),
      );
    });
  });

  // ── Summary ───────────────────────────────────────────────────────

  describe('GET /api/actions/summary', () => {
    it('returns grouped data: open, overdue, due this week, by assignee', async () => {
      services.actionService.getSummary.mockResolvedValue({
        byStatus: { open: 5, in_progress: 2, completed: 10, cancelled: 1 },
        byAssignee: {
          Alice: { open: 3, in_progress: 1 },
          Bob: { open: 2, in_progress: 1 },
        },
        overdue: 2,
        dueThisWeek: 4,
        total: 18,
      });

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/actions/summary',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.byStatus.open).toBe(5);
      expect(body.data.overdue).toBe(2);
      expect(body.data.dueThisWeek).toBe(4);
      expect(body.data.byAssignee.Alice.open).toBe(3);
      expect(services.actionService.getSummary).toHaveBeenCalledWith('user-1');
    });
  });

  // ── Meeting-scoped actions ────────────────────────────────────────

  describe('GET /api/meetings/:id/actions', () => {
    it('returns actions for a specific meeting', async () => {
      services.actionService.listByMeeting.mockResolvedValue({
        actions: [
          makeAction({ id: 'a1', title: 'Review PR' }),
          makeAction({ id: 'a2', title: 'Update docs' }),
        ],
        cursor: undefined,
        hasMore: false,
      });

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings/meeting-1/actions',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(2);
      // limit defaults to 20 from PaginationQuerySchema
      expect(services.actionService.listByMeeting).toHaveBeenCalledWith(
        'meeting-1', 'user-1', undefined, 20,
      );
    });
  });

  // ── Delete ────────────────────────────────────────────────────────

  describe('DELETE /api/actions/:id', () => {
    it('returns 404 for action owned by another user', async () => {
      services.actionService.delete.mockResolvedValue(false);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/actions/other-user-action',
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
