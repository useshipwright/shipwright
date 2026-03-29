/**
 * Action item route plugin.
 *
 * Registers /api/actions and /api/meetings/:id/actions endpoints
 * with Zod-validated schemas converted to JSON Schema for Fastify (ADR-011).
 *
 * All responses use the standard envelope: { data: T, meta?: { cursor, hasMore } }
 */

import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  CreateActionBodySchema,
  UpdateActionBodySchema,
  ListActionsQuerySchema,
  IdParamSchema,
  PaginationQuerySchema,
  type CreateActionBody,
  type UpdateActionBody,
  type ListActionsQuery,
  type IdParam,
  type PaginationQuery,
} from '../types/api.js';
import type { ActionService } from '../services/action.js';

// ── Plugin options ──────────────────────────────────────────────────

export interface ActionRoutesOptions {
  actionService: ActionService;
}

// ── Helper: convert Zod to Fastify JSON Schema ──────────────────────

function zodSchema(schema: z.ZodType): Record<string, unknown> {
  return (zodToJsonSchema as (...args: unknown[]) => Record<string, unknown>)(schema);
}

// ── Route plugin ────────────────────────────────────────────────────

const actionRoutes: FastifyPluginAsync<ActionRoutesOptions> = async (
  app: FastifyInstance,
  opts: ActionRoutesOptions,
) => {
  const { actionService } = opts;

  // ── GET /api/actions ──────────────────────────────────────────────
  app.get<{ Querystring: ListActionsQuery }>(
    '/',
    {
      schema: {
        querystring: zodSchema(ListActionsQuerySchema),
      },
    },
    async (request) => {
      const q = request.query;
      const result = await actionService.list({
        userId: request.userId,
        status: q.status,
        assignee: q.assignee,
        meetingId: q.meetingId,
        dueBefore: q.dueBefore,
        dueAfter: q.dueAfter,
        cursor: q.cursor,
        limit: q.limit,
      });

      return {
        data: result.actions,
        meta: {
          cursor: result.cursor,
          hasMore: result.hasMore,
        },
      };
    },
  );

  // ── GET /api/actions/summary ──────────────────────────────────────
  app.get('/summary', async (request) => {
    const summary = await actionService.getSummary(request.userId);
    return { data: summary };
  });

  // ── POST /api/actions ─────────────────────────────────────────────
  app.post<{ Body: CreateActionBody }>(
    '/',
    {
      schema: {
        body: zodSchema(CreateActionBodySchema),
      },
    },
    async (request, reply) => {
      const action = await actionService.create({
        userId: request.userId,
        title: request.body.title,
        meetingId: request.body.meetingId,
        assignee: request.body.assignee,
        dueDate: request.body.dueDate,
        status: request.body.status,
      });

      return reply.code(201).send({ data: action });
    },
  );

  // ── PUT /api/actions/:id ──────────────────────────────────────────
  app.put<{ Params: IdParam; Body: UpdateActionBody }>(
    '/:id',
    {
      schema: {
        params: zodSchema(IdParamSchema),
        body: zodSchema(UpdateActionBodySchema),
      },
    },
    async (request, reply) => {
      const updated = await actionService.update(
        request.params.id,
        request.userId,
        request.body,
      );
      if (!updated) {
        return reply.code(404).send({
          error: { code: 404, message: 'Action item not found' },
        });
      }
      return { data: updated };
    },
  );

  // ── DELETE /api/actions/:id ───────────────────────────────────────
  app.delete<{ Params: IdParam }>(
    '/:id',
    {
      schema: {
        params: zodSchema(IdParamSchema),
      },
    },
    async (request, reply) => {
      const deleted = await actionService.delete(
        request.params.id,
        request.userId,
      );
      if (!deleted) {
        return reply.code(404).send({
          error: { code: 404, message: 'Action item not found' },
        });
      }
      return { data: { id: request.params.id, deleted: true } };
    },
  );
};

export default actionRoutes;

// ── Meeting-scoped actions route plugin ─────────────────────────────

export interface MeetingActionsRoutesOptions {
  actionService: ActionService;
}

export const meetingActionsRoutes: FastifyPluginAsync<MeetingActionsRoutesOptions> = async (
  app: FastifyInstance,
  opts: MeetingActionsRoutesOptions,
) => {
  const { actionService } = opts;

  // ── GET /api/meetings/:id/actions ─────────────────────────────────
  app.get<{ Params: IdParam; Querystring: PaginationQuery }>(
    '/:id/actions',
    {
      schema: {
        params: zodSchema(IdParamSchema),
        querystring: zodSchema(PaginationQuerySchema),
      },
    },
    async (request) => {
      const result = await actionService.listByMeeting(
        request.params.id,
        request.userId,
        request.query.cursor,
        request.query.limit,
      );

      return {
        data: result.actions,
        meta: {
          cursor: result.cursor,
          hasMore: result.hasMore,
        },
      };
    },
  );
};
