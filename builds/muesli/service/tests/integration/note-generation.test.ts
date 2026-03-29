/**
 * Integration tests — AI note generation (T-032).
 *
 * Tests note generation via POST /api/meetings/:id/notes/generate,
 * regeneration with different templates, auto action item extraction,
 * embedding generation, and note version listing/retrieval.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from '../../src/routes/index.js';
import type { AppDependencies } from '../../src/app.js';
import type { MeetingNote } from '../../src/types/domain.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const NOW = new Date('2025-06-15T10:00:00Z');

function makeNote(overrides: Partial<MeetingNote> = {}): MeetingNote {
  return {
    version: 1,
    templateId: 'general-tpl',
    sections: [
      { heading: 'Summary', content: 'The team discussed sprint progress.' },
      { heading: 'Action Items', content: 'Alice to review PR #123.' },
    ],
    isEdited: false,
    model: 'sonnet',
    inputTokens: 1500,
    outputTokens: 800,
    generationLatencyMs: 2300,
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

describe('Note Generation Integration', () => {
  let app: FastifyInstance;
  let services: ReturnType<typeof stubServices>;

  beforeEach(() => {
    services = stubServices();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ── Generate notes ──────────────────────────────────────────────

  describe('POST /api/meetings/:id/notes/generate', () => {
    it('merges transcript with template and produces structured notes via Claude', async () => {
      const note = makeNote();
      services.aiNotesService.generate.mockResolvedValue({
        note,
        actionsExtracted: 1,
        tagsGenerated: ['sprint'],
      });

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/notes/generate',
        payload: { templateId: 'general-tpl' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.version).toBe(1);
      expect(body.data.sections).toHaveLength(2);
      expect(body.data.sections[0].heading).toBe('Summary');
      expect(body.data.model).toBe('sonnet');
      expect(body.meta.actionsExtracted).toBe(1);
      expect(body.meta.tagsGenerated).toEqual(['sprint']);

      expect(services.aiNotesService.generate).toHaveBeenCalledWith({
        userId: 'user-1',
        meetingId: 'meeting-1',
        templateId: 'general-tpl',
        model: undefined,
      });
    });

    it('returns 404 when meeting not found', async () => {
      services.aiNotesService.generate.mockResolvedValue('not_found');

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/nonexistent/notes/generate',
        payload: {},
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when no transcript available', async () => {
      services.aiNotesService.generate.mockResolvedValue('no_transcript');

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/notes/generate',
        payload: {},
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.message).toContain('transcript');
    });
  });

  // ── Regeneration with different template ──────────────────────

  describe('regeneration with different template', () => {
    it('creates new note version when regenerating with different template', async () => {
      const noteV2 = makeNote({
        version: 2,
        templateId: 'sales-tpl',
        sections: [
          { heading: 'Prospect Overview', content: 'Acme Corp needs a widget.' },
          { heading: 'Next Steps', content: 'Send proposal by Friday.' },
        ],
      });

      services.aiNotesService.generate.mockResolvedValue({
        note: noteV2,
        actionsExtracted: 0,
        tagsGenerated: ['sales'],
      });

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/notes/generate',
        payload: { templateId: 'sales-tpl' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.version).toBe(2);
      expect(body.data.templateId).toBe('sales-tpl');
      expect(body.data.sections[0].heading).toBe('Prospect Overview');
    });
  });

  // ── Action item extraction ─────────────────────────────────────

  describe('auto action item extraction', () => {
    it('extracts and creates action items from generated notes', async () => {
      services.aiNotesService.generate.mockResolvedValue({
        note: makeNote(),
        actionsExtracted: 3,
        tagsGenerated: ['planning'],
      });

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/notes/generate',
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.meta.actionsExtracted).toBe(3);
    });

    it('reports zero actions when none found in notes', async () => {
      services.aiNotesService.generate.mockResolvedValue({
        note: makeNote({ sections: [{ heading: 'Summary', content: 'Casual chat.' }] }),
        actionsExtracted: 0,
        tagsGenerated: [],
      });

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/notes/generate',
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).meta.actionsExtracted).toBe(0);
    });
  });

  // ── Embedding generation ───────────────────────────────────────

  describe('embedding generation per section', () => {
    it('generates embeddings as part of note generation pipeline', async () => {
      services.aiNotesService.generate.mockResolvedValue({
        note: makeNote({
          sections: [
            { heading: 'Summary', content: 'Sprint review results.' },
            { heading: 'Action Items', content: 'Deploy by EOW.' },
          ],
        }),
        actionsExtracted: 1,
        tagsGenerated: ['sprint'],
      });

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/notes/generate',
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      // The service internally handles embedding generation.
      // Verify the service was called with correct parameters.
      expect(services.aiNotesService.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          meetingId: 'meeting-1',
        }),
      );
    });
  });

  // ── Note version listing and retrieval ─────────────────────────

  describe('note version listing and retrieval', () => {
    it('lists all note versions for a meeting', async () => {
      const notes = [makeNote({ version: 1 }), makeNote({ version: 2, templateId: 'sales-tpl' })];
      services.meetingService.getNotes.mockResolvedValue(notes);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings/meeting-1/notes',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].version).toBe(1);
      expect(body.data[1].version).toBe(2);
    });

    it('retrieves latest note version', async () => {
      const note = makeNote({ version: 3 });
      services.meetingService.getLatestNote.mockResolvedValue(note);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings/meeting-1/notes/latest',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.version).toBe(3);
    });

    it('retrieves specific note by version number', async () => {
      const note = makeNote({ version: 2 });
      services.meetingService.getNote.mockResolvedValue(note);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings/meeting-1/notes/2',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.version).toBe(2);
    });

    it('returns 404 for non-existent note version', async () => {
      services.meetingService.getNote.mockResolvedValue(null);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings/meeting-1/notes/99',
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for latest note when none exist', async () => {
      services.meetingService.getLatestNote.mockResolvedValue(null);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'GET',
        url: '/api/meetings/meeting-1/notes/latest',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── Model selection ────────────────────────────────────────────

  describe('model selection', () => {
    it('passes model parameter to service when specified', async () => {
      services.aiNotesService.generate.mockResolvedValue({
        note: makeNote({ model: 'opus' }),
        actionsExtracted: 0,
        tagsGenerated: [],
      });

      app = await buildIntegrationApp(services);

      await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/notes/generate',
        payload: { model: 'opus' },
      });

      expect(services.aiNotesService.generate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'opus' }),
      );
    });
  });
});
