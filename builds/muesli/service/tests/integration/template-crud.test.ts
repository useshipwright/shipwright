/**
 * Integration tests — template CRUD (T-032).
 *
 * Tests template listing (system + custom), system template immutability (403),
 * custom template CRUD scoped to userId, and system template seeding.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from '../../src/routes/index.js';
import type { AppDependencies } from '../../src/app.js';
import type { Template } from '../../src/types/domain.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const NOW = new Date('2025-06-15T10:00:00Z');

function makeSystemTemplate(name: string, id: string): Template {
  return {
    id,
    name,
    isSystem: true,
    sections: [
      { heading: 'Summary', prompt: 'Summarize the meeting.' },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeCustomTemplate(overrides: Partial<Template> = {}): Template {
  return {
    id: 'custom-tpl-1',
    name: 'My Template',
    isSystem: false,
    userId: 'user-1',
    sections: [
      { heading: 'Notes', prompt: 'Take notes.' },
    ],
    createdAt: NOW,
    updatedAt: NOW,
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

describe('Template CRUD Integration', () => {
  let app: FastifyInstance;
  let services: ReturnType<typeof stubServices>;

  beforeEach(() => {
    services = stubServices();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ── Listing ────────────────────────────────────────────────────

  describe('listing templates', () => {
    it('returns both system and custom templates', async () => {
      const templates: Template[] = [
        makeSystemTemplate('General', 'sys-1'),
        makeSystemTemplate('1:1', 'sys-2'),
        makeSystemTemplate('Sales', 'sys-3'),
        makeSystemTemplate('Standup', 'sys-4'),
        makeSystemTemplate('Retro', 'sys-5'),
        makeSystemTemplate('Interview', 'sys-6'),
        makeSystemTemplate('Board', 'sys-7'),
        makeCustomTemplate(),
      ];

      services.templateService.list.mockResolvedValue(templates);

      app = await buildIntegrationApp(services);

      const res = await app.inject({ method: 'GET', url: '/api/templates' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(8);

      const systemTemplates = body.data.filter((t: Template) => t.isSystem);
      const customTemplates = body.data.filter((t: Template) => !t.isSystem);
      expect(systemTemplates).toHaveLength(7);
      expect(customTemplates).toHaveLength(1);
    });

    it('passes userId to service for scoped listing', async () => {
      services.templateService.list.mockResolvedValue([]);
      app = await buildIntegrationApp(services);

      await app.inject({ method: 'GET', url: '/api/templates' });
      expect(services.templateService.list).toHaveBeenCalledWith('user-1');
    });
  });

  // ── System template immutability ──────────────────────────────

  describe('system templates are read-only', () => {
    it('returns 403 on PUT to system template', async () => {
      services.templateService.update.mockResolvedValue('system');

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/templates/sys-1',
        payload: { name: 'Renamed' },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.message).toContain('system');
    });

    it('returns 403 on DELETE of system template', async () => {
      services.templateService.delete.mockResolvedValue('system');

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/templates/sys-1',
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ── Custom template CRUD ──────────────────────────────────────

  describe('custom template CRUD scoped to userId', () => {
    it('creates a custom template', async () => {
      const created = makeCustomTemplate();
      services.templateService.create.mockResolvedValue(created);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'POST',
        url: '/api/templates',
        payload: {
          name: 'My Template',
          sections: [{ heading: 'Notes', prompt: 'Take notes.' }],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data.name).toBe('My Template');
      expect(body.data.isSystem).toBe(false);

      expect(services.templateService.create).toHaveBeenCalledWith({
        userId: 'user-1',
        name: 'My Template',
        sections: [{ heading: 'Notes', prompt: 'Take notes.' }],
      });
    });

    it('updates a custom template', async () => {
      const updated = makeCustomTemplate({ name: 'Renamed Template' });
      services.templateService.update.mockResolvedValue(updated);

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/templates/custom-tpl-1',
        payload: { name: 'Renamed Template' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.name).toBe('Renamed Template');
      expect(services.templateService.update).toHaveBeenCalledWith(
        'custom-tpl-1',
        'user-1',
        expect.objectContaining({ name: 'Renamed Template' }),
      );
    });

    it('deletes a custom template', async () => {
      services.templateService.delete.mockResolvedValue('ok');

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/templates/custom-tpl-1',
      });

      expect(res.statusCode).toBe(200);
      expect(services.templateService.delete).toHaveBeenCalledWith('custom-tpl-1', 'user-1');
    });

    it('returns 404 when updating non-existent template', async () => {
      services.templateService.update.mockResolvedValue('not_found');

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/templates/nonexistent',
        payload: { name: 'Foo' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when deleting non-existent template', async () => {
      services.templateService.delete.mockResolvedValue('not_found');

      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/templates/nonexistent',
      });

      expect(res.statusCode).toBe(404);
    });

    it('gets a template by ID', async () => {
      const tpl = makeCustomTemplate();
      services.templateService.getById.mockResolvedValue(tpl);

      app = await buildIntegrationApp(services);

      const res = await app.inject({ method: 'GET', url: '/api/templates/custom-tpl-1' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.id).toBe('custom-tpl-1');
    });

    it('returns 404 for template owned by different user', async () => {
      const otherUserTpl = makeCustomTemplate({ userId: 'user-2' });
      services.templateService.getById.mockResolvedValue(otherUserTpl);

      app = await buildIntegrationApp(services);

      const res = await app.inject({ method: 'GET', url: '/api/templates/custom-tpl-1' });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── System template seeding ───────────────────────────────────

  describe('system template seeding on first run', () => {
    it('seeds 7 built-in system templates', async () => {
      const { createTemplateService } = await import('../../src/services/template.js');

      const mockFirestore = {
        listTemplates: vi.fn().mockResolvedValue([]),
        createTemplate: vi.fn().mockResolvedValue(undefined),
      };

      const service = createTemplateService({ firestore: mockFirestore as never });
      await service.seedSystemTemplates();

      expect(mockFirestore.createTemplate).toHaveBeenCalledTimes(7);

      // Verify all 7 template names
      const createdNames = mockFirestore.createTemplate.mock.calls.map(
        (call: unknown[]) => (call[0] as Template).name,
      );
      expect(createdNames).toContain('General');
      expect(createdNames).toContain('1:1');
      expect(createdNames).toContain('Sales');
      expect(createdNames).toContain('Standup');
      expect(createdNames).toContain('Retro');
      expect(createdNames).toContain('Interview');
      expect(createdNames).toContain('Board');

      // Verify all are marked as system templates
      for (const call of mockFirestore.createTemplate.mock.calls) {
        expect((call[0] as Template).isSystem).toBe(true);
      }
    });

    it('is idempotent — skips seeding when system templates already exist', async () => {
      const { createTemplateService } = await import('../../src/services/template.js');

      const existingSystemTemplates = [
        makeSystemTemplate('General', 'sys-1'),
        makeSystemTemplate('1:1', 'sys-2'),
        makeSystemTemplate('Sales', 'sys-3'),
        makeSystemTemplate('Standup', 'sys-4'),
        makeSystemTemplate('Retro', 'sys-5'),
        makeSystemTemplate('Interview', 'sys-6'),
        makeSystemTemplate('Board', 'sys-7'),
      ];

      const mockFirestore = {
        listTemplates: vi.fn().mockResolvedValue(existingSystemTemplates),
        createTemplate: vi.fn(),
      };

      const service = createTemplateService({ firestore: mockFirestore as never });
      await service.seedSystemTemplates();

      expect(mockFirestore.createTemplate).not.toHaveBeenCalled();
    });
  });

  // ── Validation ────────────────────────────────────────────────

  describe('input validation', () => {
    it('rejects template creation with empty name', async () => {
      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'POST',
        url: '/api/templates',
        payload: { name: '', sections: [{ heading: 'A', prompt: 'B' }] },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects template creation with empty sections', async () => {
      app = await buildIntegrationApp(services);

      const res = await app.inject({
        method: 'POST',
        url: '/api/templates',
        payload: { name: 'Valid Name', sections: [] },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
