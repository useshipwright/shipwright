/**
 * Template route tests — T-028.
 *
 * Tests HTTP layer: Zod validation, status codes, response envelope format,
 * system template immutability (403), and isSystem flag protection.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import templateRoutes from '../../src/routes/templates.js';
import type { TemplateService } from '../../src/services/template.js';
import type { Template } from '../../src/types/domain.js';
import { buildApp } from '../../src/app.js';

// ── Fixtures ────────────────────────────────────────────────────────

function makeTemplate(overrides: Partial<Template> = {}): Template {
  return {
    id: 'tpl-1',
    name: 'Custom Template',
    isSystem: false,
    userId: 'user-1',
    sections: [{ heading: 'Summary', prompt: 'Summarize.' }],
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ── Mock template service ───────────────────────────────────────────

function mockTemplateService(): TemplateService {
  return {
    list: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    seedSystemTemplates: vi.fn(),
  } as unknown as TemplateService;
}

// ── Build test app with auth bypass ─────────────────────────────────

async function buildTestApp(templateService: TemplateService): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorateRequest('userId', '');
  app.decorateRequest('userEmail', '');
  app.addHook('onRequest', async (request) => {
    request.userId = 'user-1';
    request.userEmail = 'user@test.com';
  });

  await app.register(templateRoutes, {
    prefix: '/api/templates',
    templateService,
  });

  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Template Routes', () => {
  let app: FastifyInstance;
  let templateSvc: TemplateService;

  beforeEach(() => {
    templateSvc = mockTemplateService();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('GET /api/templates', () => {
    it('returns 200 with templates in envelope', async () => {
      vi.mocked(templateSvc.list).mockResolvedValue([
        makeTemplate({ id: 'sys-1', name: 'General', isSystem: true }),
        makeTemplate(),
      ]);
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/templates',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(2);
    });

    it('passes userId from request to service', async () => {
      vi.mocked(templateSvc.list).mockResolvedValue([]);
      app = await buildTestApp(templateSvc);

      await app.inject({ method: 'GET', url: '/api/templates' });

      expect(templateSvc.list).toHaveBeenCalledWith('user-1');
    });
  });

  describe('GET /api/templates/:id', () => {
    it('returns 200 for system template', async () => {
      vi.mocked(templateSvc.getById).mockResolvedValue(
        makeTemplate({ isSystem: true, name: 'General' }),
      );
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/templates/sys-1',
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 200 for own custom template', async () => {
      vi.mocked(templateSvc.getById).mockResolvedValue(makeTemplate({ userId: 'user-1' }));
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/templates/tpl-1',
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 404 for other users custom template', async () => {
      vi.mocked(templateSvc.getById).mockResolvedValue(
        makeTemplate({ userId: 'other-user', isSystem: false }),
      );
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/templates/tpl-other',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(404);
    });

    it('returns 404 when template not found', async () => {
      vi.mocked(templateSvc.getById).mockResolvedValue(null);
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'GET',
        url: '/api/templates/nonexistent',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/templates', () => {
    it('returns 201 with created template', async () => {
      vi.mocked(templateSvc.create).mockResolvedValue(makeTemplate());
      app = await buildTestApp(templateSvc);

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
      expect(body.data).toBeDefined();
    });

    it('returns 400 when name is missing', async () => {
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/templates',
        payload: {
          sections: [{ heading: 'A', prompt: 'B' }],
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when sections is empty array', async () => {
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/templates',
        payload: {
          name: 'Empty',
          sections: [],
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when section heading is empty', async () => {
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/templates',
        payload: {
          name: 'Bad',
          sections: [{ heading: '', prompt: 'Something' }],
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when section prompt is empty', async () => {
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/templates',
        payload: {
          name: 'Bad',
          sections: [{ heading: 'Title', prompt: '' }],
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('cannot set isSystem flag via API (stripped by schema)', async () => {
      vi.mocked(templateSvc.create).mockResolvedValue(makeTemplate());
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'POST',
        url: '/api/templates',
        payload: {
          name: 'Sneaky',
          sections: [{ heading: 'A', prompt: 'B' }],
          isSystem: true, // This should be ignored
        },
      });

      expect(res.statusCode).toBe(201);
      // The service create method doesn't accept isSystem param
      expect(vi.mocked(templateSvc.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          name: 'Sneaky',
        }),
      );
      // Verify isSystem is NOT in the create params
      const callArgs = vi.mocked(templateSvc.create).mock.calls[0][0];
      expect('isSystem' in callArgs).toBe(false);
    });
  });

  describe('PUT /api/templates/:id', () => {
    it('returns 200 with updated template', async () => {
      vi.mocked(templateSvc.update).mockResolvedValue(makeTemplate({ name: 'Updated' }));
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/templates/tpl-1',
        payload: { name: 'Updated' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.name).toBe('Updated');
    });

    it('returns 403 when updating system template', async () => {
      vi.mocked(templateSvc.update).mockResolvedValue('system');
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/templates/sys-1',
        payload: { name: 'Hacked' },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(403);
      expect(body.error.message).toContain('system');
    });

    it('returns 404 when template not found', async () => {
      vi.mocked(templateSvc.update).mockResolvedValue('not_found');
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/templates/nonexistent',
        payload: { name: 'X' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when name is empty', async () => {
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/templates/tpl-1',
        payload: { name: '' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/templates/:id', () => {
    it('returns 200 with deleted confirmation', async () => {
      vi.mocked(templateSvc.delete).mockResolvedValue('ok');
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/templates/tpl-1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.deleted).toBe(true);
    });

    it('returns 403 when deleting system template', async () => {
      vi.mocked(templateSvc.delete).mockResolvedValue('system');
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/templates/sys-1',
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(403);
    });

    it('returns 404 when template not found', async () => {
      vi.mocked(templateSvc.delete).mockResolvedValue('not_found');
      app = await buildTestApp(templateSvc);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/templates/nonexistent',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('integration: buildApp wiring', () => {
    it('template routes are accessible through production entry point', async () => {
      app = await buildApp({ templateService: templateSvc } as Record<string, unknown>);
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/api/templates',
      });

      // 401 means auth middleware is active and the route is wired
      expect(res.statusCode).toBe(401);
    });
  });
});
