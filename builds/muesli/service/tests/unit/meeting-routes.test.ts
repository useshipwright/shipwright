/**
 * Meeting route tests — T-028.
 *
 * Tests HTTP layer: Zod validation, status codes, response envelope format.
 * Uses app.inject() for integration testing and buildApp from production entry point.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import meetingRoutes from '../../src/routes/meetings.js';
import type { MeetingService } from '../../src/services/meeting.js';
import type { Meeting, MeetingNote } from '../../src/types/domain.js';
import { buildApp } from '../../src/app.js';

// ── Fixtures ────────────────────────────────────────────────────────

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'meeting-1',
    userId: 'user-1',
    title: 'Test Meeting',
    status: 'ready',
    attendees: [{ name: 'Alice' }],
    tags: ['dev'],
    isStarred: false,
    latestNoteVersion: 0,
    searchTokens: ['test', 'meeting'],
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ── Mock meeting service ────────────────────────────────────────────

function mockMeetingService(): MeetingService {
  return {
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
  } as unknown as MeetingService;
}

// ── Build test app with auth bypass ─────────────────────────────────

async function buildTestApp(meetingService: MeetingService): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Bypass auth — decorate request with userId/userEmail
  app.decorateRequest('userId', '');
  app.decorateRequest('userEmail', '');
  app.addHook('onRequest', async (request) => {
    request.userId = 'user-1';
    request.userEmail = 'user@test.com';
  });

  await app.register(meetingRoutes, {
    prefix: '/api/meetings',
    meetingService,
  });

  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Meeting Routes', () => {
  let app: FastifyInstance;
  let meetingSvc: MeetingService;

  beforeEach(() => {
    meetingSvc = mockMeetingService();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('POST /api/meetings', () => {
    it('returns 201 with envelope on success', async () => {
      const meeting = makeMeeting();
      vi.mocked(meetingSvc.create).mockResolvedValue(meeting);
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings',
        payload: { title: 'Test Meeting' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data).toBeDefined();
      expect(body.data.id).toBe('meeting-1');
    });

    it('returns 400 when title is missing', async () => {
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when title is empty string', async () => {
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings',
        payload: { title: '' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when attendee email is invalid', async () => {
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings',
        payload: {
          title: 'Meeting',
          attendees: [{ name: 'Alice', email: 'not-an-email' }],
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('accepts valid attendees and tags', async () => {
      vi.mocked(meetingSvc.create).mockResolvedValue(makeMeeting());
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings',
        payload: {
          title: 'Team Sync',
          attendees: [{ name: 'Bob', email: 'bob@co.com' }],
          tags: ['engineering'],
        },
      });

      expect(res.statusCode).toBe(201);
      expect(vi.mocked(meetingSvc.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          title: 'Team Sync',
          attendees: [{ name: 'Bob', email: 'bob@co.com' }],
          tags: ['engineering'],
        }),
      );
    });
  });

  describe('GET /api/meetings', () => {
    it('returns 200 with envelope and pagination meta', async () => {
      vi.mocked(meetingSvc.list).mockResolvedValue({
        meetings: [makeMeeting()],
        cursor: 'next',
        hasMore: true,
      });
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(1);
      expect(body.meta.cursor).toBe('next');
      expect(body.meta.hasMore).toBe(true);
    });

    it('passes query params as filters to service', async () => {
      vi.mocked(meetingSvc.list).mockResolvedValue({
        meetings: [],
        hasMore: false,
      });
      app = await buildTestApp(meetingSvc);

      await app.inject({
        method: 'GET',
        url: '/api/meetings?status=ready&tag=dev&sortBy=title&sortOrder=asc&limit=5',
      });

      expect(vi.mocked(meetingSvc.list)).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          status: 'ready',
          tag: 'dev',
          sortBy: 'title',
          sortOrder: 'asc',
          limit: 5,
        }),
      );
    });
  });

  describe('GET /api/meetings/:id', () => {
    it('returns 200 with meeting data in envelope', async () => {
      vi.mocked(meetingSvc.getById).mockResolvedValue(makeMeeting());
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings/meeting-1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.id).toBe('meeting-1');
    });

    it('returns 404 when meeting not found', async () => {
      vi.mocked(meetingSvc.getById).mockResolvedValue(null);
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings/nonexistent',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(404);
      expect(body.error.message).toBe('Meeting not found');
    });
  });

  describe('PUT /api/meetings/:id', () => {
    it('returns 200 with updated meeting in envelope', async () => {
      vi.mocked(meetingSvc.update).mockResolvedValue(makeMeeting({ title: 'Updated' }));
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/meetings/meeting-1',
        payload: { title: 'Updated' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.title).toBe('Updated');
    });

    it('returns 404 when meeting not found', async () => {
      vi.mocked(meetingSvc.update).mockResolvedValue(null);
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/meetings/meeting-1',
        payload: { title: 'X' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when title is empty', async () => {
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/meetings/meeting-1',
        payload: { title: '' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/meetings/:id', () => {
    it('returns 200 with deleted confirmation', async () => {
      vi.mocked(meetingSvc.delete).mockResolvedValue(true);
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/meetings/meeting-1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.deleted).toBe(true);
    });

    it('returns 404 when meeting not found', async () => {
      vi.mocked(meetingSvc.delete).mockResolvedValue(false);
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/meetings/meeting-1',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/meetings/:id/transcript', () => {
    it('returns paginated transcript segments', async () => {
      vi.mocked(meetingSvc.getTranscript).mockResolvedValue({
        segments: [{ id: 'seg-1', speaker: 'Alice', speakerId: 'spk-1', text: 'Hello', startTime: 0, endTime: 5, channel: 'system_audio', isUserNote: false, searchTokens: [] }],
        cursor: 'next',
        hasMore: true,
      });
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings/meeting-1/transcript',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(1);
      expect(body.meta.hasMore).toBe(true);
    });
  });

  describe('GET /api/meetings/:id/notes/latest', () => {
    it('returns 404 when no notes exist', async () => {
      vi.mocked(meetingSvc.getLatestNote).mockResolvedValue(null);
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings/meeting-1/notes/latest',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain('notes');
    });

    it('returns 200 with note data', async () => {
      const note: MeetingNote = {
        version: 1,
        templateId: 'tpl-1',
        sections: [{ heading: 'Summary', content: 'Test' }],
        isEdited: false,
        model: 'sonnet',
        inputTokens: 100,
        outputTokens: 50,
        generationLatencyMs: 500,
        generatedAt: new Date(),
      };
      vi.mocked(meetingSvc.getLatestNote).mockResolvedValue(note);
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings/meeting-1/notes/latest',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.version).toBe(1);
    });
  });

  describe('PUT /api/meetings/:id/notes/:version', () => {
    it('returns 400 when sections is missing', async () => {
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/meetings/meeting-1/notes/1',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when section heading is empty', async () => {
      app = await buildTestApp(meetingSvc);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/meetings/meeting-1/notes/1',
        payload: { sections: [{ heading: '', content: 'test' }] },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('integration: buildApp wiring', () => {
    it('meeting routes are accessible through production entry point', async () => {
      vi.mocked(meetingSvc.list).mockResolvedValue({
        meetings: [],
        hasMore: false,
      });

      // Use buildApp from src/app.ts — the production entry point
      app = await buildApp({ meetingService: meetingSvc } as Record<string, unknown>);
      await app.ready();

      // The route should be registered at /api/meetings
      // Auth will reject (no valid token), which proves the route exists
      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings',
      });

      // 401 means auth middleware is active and the route is wired
      expect(res.statusCode).toBe(401);
    });
  });
});
