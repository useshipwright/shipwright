/**
 * Template CRUD route plugin.
 *
 * Registers all /api/templates endpoints with Zod-validated schemas
 * converted to JSON Schema for Fastify's Ajv validation (ADR-011).
 *
 * System templates are read-only — PUT/DELETE returns 403.
 * Custom templates are scoped to the authenticated user's userId.
 */

import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  CreateTemplateBodySchema,
  UpdateTemplateBodySchema,
  IdParamSchema,
  type CreateTemplateBody,
  type UpdateTemplateBody,
  type IdParam,
} from '../types/api.js';
import type { TemplateService } from '../services/template.js';

// ── Plugin options ──────────────────────────────────────────────────

export interface TemplateRoutesOptions {
  templateService: TemplateService;
}

// ── Helper: convert Zod to Fastify JSON Schema ──────────────────────

function zodSchema(schema: z.ZodType): Record<string, unknown> {
  return (zodToJsonSchema as (...args: unknown[]) => Record<string, unknown>)(schema);
}

// ── Route plugin ────────────────────────────────────────────────────

const templateRoutes: FastifyPluginAsync<TemplateRoutesOptions> = async (
  app: FastifyInstance,
  opts: TemplateRoutesOptions,
) => {
  const { templateService } = opts;

  // ── GET /api/templates ──────────────────────────────────────────
  app.get(
    '/',
    async (request) => {
      const templates = await templateService.list(request.userId);
      return { data: templates };
    },
  );

  // ── GET /api/templates/:id ──────────────────────────────────────
  app.get<{ Params: IdParam }>(
    '/:id',
    {
      schema: {
        params: zodSchema(IdParamSchema),
      },
    },
    async (request, reply) => {
      const template = await templateService.getById(request.params.id);
      if (!template) {
        return reply.code(404).send({
          error: { code: 404, message: 'Template not found' },
        });
      }
      // Custom templates are only visible to their owner
      if (!template.isSystem && template.userId !== request.userId) {
        return reply.code(404).send({
          error: { code: 404, message: 'Template not found' },
        });
      }
      return { data: template };
    },
  );

  // ── POST /api/templates ─────────────────────────────────────────
  app.post<{ Body: CreateTemplateBody }>(
    '/',
    {
      schema: {
        body: zodSchema(CreateTemplateBodySchema),
      },
    },
    async (request, reply) => {
      const template = await templateService.create({
        userId: request.userId,
        name: request.body.name,
        sections: request.body.sections,
      });
      return reply.code(201).send({ data: template });
    },
  );

  // ── PUT /api/templates/:id ──────────────────────────────────────
  app.put<{ Params: IdParam; Body: UpdateTemplateBody }>(
    '/:id',
    {
      schema: {
        params: zodSchema(IdParamSchema),
        body: zodSchema(UpdateTemplateBodySchema),
      },
    },
    async (request, reply) => {
      const result = await templateService.update(
        request.params.id,
        request.userId,
        {
          name: request.body.name,
          sections: request.body.sections,
        },
      );

      if (result === 'system') {
        return reply.code(403).send({
          error: { code: 403, message: 'Cannot modify system template' },
        });
      }
      if (result === 'not_found') {
        return reply.code(404).send({
          error: { code: 404, message: 'Template not found' },
        });
      }

      return { data: result };
    },
  );

  // ── DELETE /api/templates/:id ───────────────────────────────────
  app.delete<{ Params: IdParam }>(
    '/:id',
    {
      schema: {
        params: zodSchema(IdParamSchema),
      },
    },
    async (request, reply) => {
      const result = await templateService.delete(
        request.params.id,
        request.userId,
      );

      if (result === 'system') {
        return reply.code(403).send({
          error: { code: 403, message: 'Cannot delete system template' },
        });
      }
      if (result === 'not_found') {
        return reply.code(404).send({
          error: { code: 404, message: 'Template not found' },
        });
      }

      return { data: { deleted: true } };
    },
  );
};

export default templateRoutes;
