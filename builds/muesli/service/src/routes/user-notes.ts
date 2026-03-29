/**
 * User notes route plugin.
 *
 * Registers POST and GET endpoints for /api/meetings/:id/user-notes.
 * All responses use the standard envelope: { data: T }
 */

import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

import { CreateUserNoteBodySchema, IdParamSchema, type CreateUserNoteBody, type IdParam } from '../types/api.js';
import type { UserNotesService } from '../services/user-notes.js';

// ── Plugin options ──────────────────────────────────────────────────

export interface UserNotesRoutesOptions {
  userNotesService: UserNotesService;
}

// ── Helper: convert Zod to Fastify JSON Schema ──────────────────────

function zodSchema(schema: z.ZodType): Record<string, unknown> {
  return (zodToJsonSchema as (...args: unknown[]) => Record<string, unknown>)(schema);
}

// ── Route plugin ────────────────────────────────────────────────────

const userNotesRoutes: FastifyPluginAsync<UserNotesRoutesOptions> = async (
  app: FastifyInstance,
  opts: UserNotesRoutesOptions,
) => {
  const { userNotesService } = opts;

  // ── POST /api/meetings/:id/user-notes ─────────────────────────────
  app.post<{ Params: IdParam; Body: CreateUserNoteBody }>(
    '/:id/user-notes',
    {
      schema: {
        params: zodSchema(IdParamSchema),
        body: zodSchema(CreateUserNoteBodySchema),
      },
    },
    async (request, reply) => {
      const segment = await userNotesService.create({
        userId: request.userId,
        meetingId: request.params.id,
        text: request.body.text,
        timestamp: request.body.timestamp,
      });

      if (!segment) {
        return reply.code(404).send({
          error: { code: 404, message: 'Meeting not found' },
        });
      }

      return reply.code(201).send({ data: segment });
    },
  );

  // ── GET /api/meetings/:id/user-notes ──────────────────────────────
  app.get<{ Params: IdParam }>(
    '/:id/user-notes',
    {
      schema: {
        params: zodSchema(IdParamSchema),
      },
    },
    async (request) => {
      const notes = await userNotesService.list(
        request.params.id,
        request.userId,
      );
      return { data: notes };
    },
  );
};

export default userNotesRoutes;
