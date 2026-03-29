/**
 * User notes route tests — T-028.
 *
 * Tests HTTP layer: Zod validation on note content, status codes,
 * response envelope format. Uses app.inject() and buildApp from
 * the production entry point.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import userNotesRoutes from '../../src/routes/user-notes.js';
import type { UserNotesService } from '../../src/services/user-notes.js';
import type { TranscriptSegment } from '../../src/types/domain.js';
import { buildApp } from '../../src/app.js';

// ── Fixtures ────────────────────────────────────────────────────────

function makeSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: 'seg-1',
    speaker: 'User',
    speakerId: 'user',
    text: 'My note',
    startTime: 0,
    endTime: 0,
    channel: 'user_input',
    isUserNote: true,
    searchTokens: ['my', 'note'],
    ...overrides,
  };
}

// ── Mock service ────────────────────────────────────────────────────

function mockUserNotesService(): UserNotesService {
  return {
    create: vi.fn(),
    list: vi.fn(),
  } as unknown as UserNotesService;
}

// ── Build test app with auth bypass ─────────────────────────────────

async function buildTestApp(userNotesService: UserNotesService): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorateRequest('userId', '');
  app.decorateRequest('userEmail', '');
  app.addHook('onRequest', async (request) => {
    request.userId = 'user-1';
    request.userEmail = 'user@test.com';
  });

  await app.register(userNotesRoutes, {
    prefix: '/api/meetings',
    userNotesService,
  });

  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('User Notes Routes', () => {
  let app: FastifyInstance;
  let notesSvc: UserNotesService;

  beforeEach(() => {
    notesSvc = mockUserNotesService();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('POST /api/meetings/:id/user-notes', () => {
    it('returns 201 with created note in envelope', async () => {
      vi.mocked(notesSvc.create).mockResolvedValue(makeSegment());
      app = await buildTestApp(notesSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/user-notes',
        payload: { text: 'My note' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data).toBeDefined();
      expect(body.data.isUserNote).toBe(true);
    });

    it('returns 404 when meeting not found', async () => {
      vi.mocked(notesSvc.create).mockResolvedValue(null);
      app = await buildTestApp(notesSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/nonexistent/user-notes',
        payload: { text: 'My note' },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(404);
    });

    it('returns 400 when text is missing', async () => {
      app = await buildTestApp(notesSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/user-notes',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when text is empty string', async () => {
      app = await buildTestApp(notesSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/user-notes',
        payload: { text: '' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when timestamp is negative', async () => {
      app = await buildTestApp(notesSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/user-notes',
        payload: { text: 'Note', timestamp: -1 },
      });

      expect(res.statusCode).toBe(400);
    });

    it('accepts text with optional timestamp', async () => {
      vi.mocked(notesSvc.create).mockResolvedValue(makeSegment({ startTime: 42 }));
      app = await buildTestApp(notesSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/user-notes',
        payload: { text: 'Important point', timestamp: 42 },
      });

      expect(res.statusCode).toBe(201);
      expect(vi.mocked(notesSvc.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          meetingId: 'meeting-1',
          text: 'Important point',
          timestamp: 42,
        }),
      );
    });

    it('handles unicode and emoji in text', async () => {
      vi.mocked(notesSvc.create).mockResolvedValue(makeSegment({ text: '会議メモ 🎉' }));
      app = await buildTestApp(notesSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/user-notes',
        payload: { text: '会議メモ 🎉' },
      });

      expect(res.statusCode).toBe(201);
    });

    it('passes meetingId from URL params to service', async () => {
      vi.mocked(notesSvc.create).mockResolvedValue(makeSegment());
      app = await buildTestApp(notesSvc);

      await app.inject({
        method: 'POST',
        url: '/api/meetings/my-meeting-id/user-notes',
        payload: { text: 'Note' },
      });

      expect(vi.mocked(notesSvc.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          meetingId: 'my-meeting-id',
        }),
      );
    });
  });

  describe('GET /api/meetings/:id/user-notes', () => {
    it('returns 200 with notes in envelope', async () => {
      vi.mocked(notesSvc.list).mockResolvedValue([
        makeSegment({ id: 's-1', startTime: 10 }),
        makeSegment({ id: 's-2', startTime: 20 }),
      ]);
      app = await buildTestApp(notesSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings/meeting-1/user-notes',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(2);
    });

    it('returns empty data array when meeting has no notes', async () => {
      vi.mocked(notesSvc.list).mockResolvedValue([]);
      app = await buildTestApp(notesSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings/meeting-1/user-notes',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toEqual([]);
    });

    it('passes userId and meetingId to service', async () => {
      vi.mocked(notesSvc.list).mockResolvedValue([]);
      app = await buildTestApp(notesSvc);

      await app.inject({
        method: 'GET',
        url: '/api/meetings/meeting-1/user-notes',
      });

      expect(notesSvc.list).toHaveBeenCalledWith('meeting-1', 'user-1');
    });
  });

  describe('integration: buildApp wiring', () => {
    it('user notes routes are accessible through production entry point', async () => {
      app = await buildApp({ userNotesService: notesSvc } as Record<string, unknown>);
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/user-notes',
        payload: { text: 'Note' },
      });

      // 401 means auth middleware is active and the route is wired
      expect(res.statusCode).toBe(401);
    });
  });
});
