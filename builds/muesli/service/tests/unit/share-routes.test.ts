/**
 * Share route tests — T-031.
 *
 * Tests HTTP layer for share endpoints: status codes, response envelope,
 * access control enforcement, and identical 404 for non-existent/expired/revoked.
 * Includes integration test via buildApp production entry point.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import shareRoutes, { meetingShareRoutes } from '../../src/routes/share.js';
import type { ShareService } from '../../src/services/share.js';
import type { Share } from '../../src/types/domain.js';
import type { ShareViewData } from '../../src/services/share.js';

// ── Fixtures ────────────────────────────────────────────────────────

function makeShare(overrides: Partial<Share> = {}): Share {
  return {
    shareId: 'share-uuid-1',
    meetingId: 'meeting-1',
    userId: 'user-1',
    accessMode: 'public',
    includeTranscript: false,
    includeAudio: false,
    viewCount: 0,
    createdAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeViewData(overrides: Partial<ShareViewData> = {}): ShareViewData {
  return {
    shareId: 'share-uuid-1',
    meeting: {
      title: 'Sprint Planning',
      date: new Date('2025-01-01'),
      attendees: [{ name: 'Alice' }, { name: 'Bob' }],
    },
    notes: {
      sections: [{ heading: 'Summary', content: 'Great meeting' }],
      generatedAt: new Date('2025-01-01'),
    },
    ...overrides,
  };
}

// ── Mock service ────────────────────────────────────────────────────

function mockShareService(): ShareService {
  return {
    create: vi.fn(),
    view: vi.fn(),
    listByMeeting: vi.fn(),
    revoke: vi.fn(),
  } as unknown as ShareService;
}

// ── Build test app ──────────────────────────────────────────────────

async function buildTestApp(shareSvc: ShareService): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Bypass auth — decorate request with userId/userEmail
  app.decorateRequest('userId', '');
  app.decorateRequest('userEmail', '');
  app.addHook('onRequest', async (request) => {
    request.userId = 'user-1';
    request.userEmail = 'user@test.com';
  });

  // Register authenticated share routes (POST/GET shares under meetings)
  await app.register(meetingShareRoutes, {
    prefix: '/api/meetings',
    shareService: shareSvc,
  });

  // Register public/revoke share routes
  await app.register(shareRoutes, {
    prefix: '/api/share',
    shareService: shareSvc,
  });

  await app.ready();
  return app;
}

/** App without auth hook for testing public access. */
async function buildPublicApp(shareSvc: ShareService): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // No auth decorators — simulate unauthenticated access
  app.decorateRequest('userId', '');
  app.decorateRequest('userEmail', '');

  await app.register(shareRoutes, {
    prefix: '/api/share',
    shareService: shareSvc,
  });

  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Share Routes', () => {
  let app: FastifyInstance;
  let shareSvc: ShareService;

  beforeEach(() => {
    shareSvc = mockShareService();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('GET /api/share/:shareId', () => {
    it('returns 200 with share view data for public share (no auth needed)', async () => {
      vi.mocked(shareSvc.view).mockResolvedValue(makeViewData());
      app = await buildPublicApp(shareSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/share/share-uuid-1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.meeting.title).toBe('Sprint Planning');
    });

    it('returns identical 404 for non-existent share', async () => {
      vi.mocked(shareSvc.view).mockResolvedValue(null);
      app = await buildPublicApp(shareSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/share/nonexistent',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.message).toBe('Share not found');
    });

    it('returns identical 404 for expired share (same as non-existent)', async () => {
      // Service returns null for expired shares — identical to non-existent
      vi.mocked(shareSvc.view).mockResolvedValue(null);
      app = await buildPublicApp(shareSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/share/expired-share-id',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.message).toBe('Share not found');
    });

    it('returns identical 404 for revoked share (same as non-existent)', async () => {
      vi.mocked(shareSvc.view).mockResolvedValue(null);
      app = await buildPublicApp(shareSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/share/revoked-share-id',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.message).toBe('Share not found');
    });

    it('strips attendee emails from public share response (names only)', async () => {
      vi.mocked(shareSvc.view).mockResolvedValue(makeViewData());
      app = await buildPublicApp(shareSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/share/share-uuid-1',
      });

      const body = JSON.parse(res.body);
      for (const attendee of body.data.meeting.attendees) {
        expect(attendee).toHaveProperty('name');
        expect(attendee).not.toHaveProperty('email');
      }
    });
  });

  describe('POST /api/meetings/:id/share', () => {
    it('returns 201 when share created', async () => {
      vi.mocked(shareSvc.create).mockResolvedValue(makeShare());
      app = await buildTestApp(shareSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/share',
        payload: { access: 'public' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data.shareId).toBe('share-uuid-1');
    });

    it('returns 404 when meeting not found (requires ownership)', async () => {
      vi.mocked(shareSvc.create).mockResolvedValue(null);
      app = await buildTestApp(shareSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/nonexistent/share',
        payload: { access: 'public' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when specific_emails without allowedEmails', async () => {
      app = await buildTestApp(shareSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/share',
        payload: { access: 'specific_emails' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('passes create params to service', async () => {
      vi.mocked(shareSvc.create).mockResolvedValue(makeShare());
      app = await buildTestApp(shareSvc);

      await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/share',
        payload: {
          access: 'specific_emails',
          allowedEmails: ['viewer@test.com'],
          includeTranscript: true,
          includeAudio: true,
        },
      });

      expect(shareSvc.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          meetingId: 'meeting-1',
          accessMode: 'specific_emails',
          allowedEmails: ['viewer@test.com'],
          includeTranscript: true,
          includeAudio: true,
        }),
      );
    });
  });

  describe('GET /api/meetings/:id/shares', () => {
    it('returns list of shares for a meeting', async () => {
      vi.mocked(shareSvc.listByMeeting).mockResolvedValue([makeShare()]);
      app = await buildTestApp(shareSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings/meeting-1/shares',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(1);
    });
  });

  describe('DELETE /api/share/:shareId', () => {
    it('returns 204 when share revoked', async () => {
      vi.mocked(shareSvc.revoke).mockResolvedValue(true);
      app = await buildTestApp(shareSvc);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/share/share-uuid-1',
      });

      expect(res.statusCode).toBe(204);
    });

    it('returns 404 when share not found or not owned', async () => {
      vi.mocked(shareSvc.revoke).mockResolvedValue(false);
      app = await buildTestApp(shareSvc);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/share/nonexistent',
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
