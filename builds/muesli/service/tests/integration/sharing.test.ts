/**
 * Integration tests — shareable meeting notes (T-033).
 *
 * Tests share creation, public access, authenticated mode,
 * specific_emails mode, expiration, view counting, and revocation.
 *
 * Uses production route barrel (src/routes/index.ts) with auth bypass.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from '../../src/routes/index.js';
import type { AppDependencies } from '../../src/app.js';
import type { Share } from '../../src/types/domain.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const NOW = new Date('2025-06-15T10:00:00Z');

function makeShare(overrides: Partial<Share> = {}): Share {
  return {
    id: 'share-uuid-1',
    meetingId: 'meeting-1',
    userId: 'user-1',
    accessMode: 'public',
    viewCount: 0,
    createdAt: NOW,
    ...overrides,
  } as Share;
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
      create: vi.fn(),
      view: vi.fn(),
      getByShareId: vi.fn(),
      listByMeeting: vi.fn(),
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

describe('Sharing Integration', () => {
  let app: FastifyInstance;
  let services: ReturnType<typeof stubServices>;

  beforeEach(() => {
    services = stubServices();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ── Share creation ────────────────────────────────────────────────

  describe('POST /api/meetings/:id/share', () => {
    it('creates a public share link', async () => {
      const share = makeShare();
      services.shareService.create.mockResolvedValue(share);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/share',
        payload: { access: 'public' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data.id).toBe('share-uuid-1');
      expect(body.data.accessMode).toBe('public');
    });

    it('creates an authenticated share', async () => {
      const share = makeShare({ accessMode: 'authenticated' });
      services.shareService.create.mockResolvedValue(share);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/share',
        payload: { access: 'authenticated' },
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).data.accessMode).toBe('authenticated');
    });

    it('creates a specific_emails share with allowed emails', async () => {
      const share = makeShare({
        accessMode: 'specific_emails',
        allowedEmails: ['alice@test.com', 'bob@test.com'],
      });
      services.shareService.create.mockResolvedValue(share);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/share',
        payload: {
          access: 'specific_emails',
          allowedEmails: ['alice@test.com', 'bob@test.com'],
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('rejects specific_emails without allowedEmails', async () => {
      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/share',
        payload: { access: 'specific_emails' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for non-existent meeting', async () => {
      services.shareService.create.mockResolvedValue(null);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/nonexistent/share',
        payload: { access: 'public' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── Public share access ───────────────────────────────────────────

  describe('GET /api/share/:shareId (public mode)', () => {
    it('returns shared notes without auth for public shares', async () => {
      services.shareService.view.mockResolvedValue({
        title: 'Sprint Planning',
        date: NOW.toISOString(),
        attendees: [{ name: 'Alice' }, { name: 'Bob' }],
        notes: { sections: [{ heading: 'Summary', content: 'Good meeting.' }] },
      });

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/share/share-uuid-1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.title).toBe('Sprint Planning');
      expect(body.data.attendees).toHaveLength(2);
      // Verify no emails in attendees (security)
      for (const attendee of body.data.attendees) {
        expect(attendee.email).toBeUndefined();
      }
    });

    it('returns identical 404 for non-existent share', async () => {
      services.shareService.view.mockResolvedValue(null);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/share/nonexistent-id',
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.message).toBe('Share not found');
    });
  });

  // ── Expired shares ────────────────────────────────────────────────

  describe('expired shares', () => {
    it('returns 404 for expired share — identical to non-existent', async () => {
      // Service returns null for expired shares
      services.shareService.view.mockResolvedValue(null);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/share/expired-share-id',
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.message).toBe('Share not found');
    });
  });

  // ── View count ────────────────────────────────────────────────────

  describe('view count increments', () => {
    it('service is called on each access (view count managed by service)', async () => {
      // First access
      services.shareService.view.mockResolvedValueOnce({
        title: 'Meeting', attendees: [], notes: { sections: [] },
        viewCount: 1,
      });
      // Second access
      services.shareService.view.mockResolvedValueOnce({
        title: 'Meeting', attendees: [], notes: { sections: [] },
        viewCount: 2,
      });

      app = await buildIntegrationApp(services);

      await app.inject({ method: 'GET', url: '/api/share/share-uuid-1' });
      const res2 = await app.inject({ method: 'GET', url: '/api/share/share-uuid-1' });

      expect(services.shareService.view).toHaveBeenCalledTimes(2);
      const body2 = JSON.parse(res2.body);
      expect(body2.data.viewCount).toBe(2);
    });
  });

  // ── Share revocation ──────────────────────────────────────────────

  describe('DELETE /api/share/:shareId', () => {
    it('revokes a share link (owner only)', async () => {
      services.shareService.revoke.mockResolvedValue(true);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/share/share-uuid-1',
      });

      expect(res.statusCode).toBe(204);
      expect(services.shareService.revoke).toHaveBeenCalledWith('share-uuid-1', 'user-1');
    });

    it('returns 404 when revoking non-existent share', async () => {
      services.shareService.revoke.mockResolvedValue(false);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/share/nonexistent-id',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── List shares ───────────────────────────────────────────────────

  describe('GET /api/meetings/:id/shares', () => {
    it('lists active shares for a meeting', async () => {
      services.shareService.listByMeeting.mockResolvedValue([
        makeShare({ id: 's1', accessMode: 'public' }),
        makeShare({ id: 's2', accessMode: 'authenticated' }),
      ]);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings/meeting-1/shares',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(2);
    });
  });
});
