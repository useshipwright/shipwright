/**
 * User profile route plugin — GET/PUT/DELETE /api/me.
 *
 * GET    /api/me  — Return current user profile and preferences
 * PUT    /api/me  — Update user preferences (Zod validated)
 * DELETE /api/me  — GDPR account deletion with full cascade
 *
 * SECURITY:
 * - All operations use userId from verified JWT (auth middleware)
 * - Error responses do not leak internal details
 * - DELETE cascades to all user data per threat model
 */

import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

import { UpdateUserBodySchema, type UpdateUserBody } from '../types/api.js';
import type { UserService } from '../services/user.js';

// ── Plugin options ──────────────────────────────────────────────────

export interface UserRoutesOptions {
  userService: UserService;
}

// ── Helper: convert Zod to Fastify JSON Schema ──────────────────────

function zodSchema(schema: z.ZodType): Record<string, unknown> {
  return (zodToJsonSchema as (...args: unknown[]) => Record<string, unknown>)(schema);
}

// ── Route plugin ────────────────────────────────────────────────────

const userRoutes: FastifyPluginAsync<UserRoutesOptions> = async (
  app: FastifyInstance,
  opts: UserRoutesOptions,
) => {
  const { userService } = opts;

  // ── GET /api/me ─────────────────────────────────────────────────
  app.get('/', async (request, reply) => {
    const { userId, userEmail } = request;

    const profile = await userService.getProfile(userId, userEmail);
    return reply.send({ data: profile });
  });

  // ── PUT /api/me ─────────────────────────────────────────────────
  app.put<{ Body: UpdateUserBody }>(
    '/',
    {
      schema: {
        body: zodSchema(UpdateUserBodySchema),
      },
    },
    async (request, reply) => {
      const { userId } = request;
      const body = request.body;

      try {
        const updated = await userService.updateProfile(userId, body);
        return reply.send({ data: updated });
      } catch {
        return reply.code(404).send({
          error: { code: 404, message: 'User not found' },
        });
      }
    },
  );

  // ── DELETE /api/me ──────────────────────────────────────────────
  app.delete('/', async (request, reply) => {
    const { userId } = request;

    try {
      await userService.deleteAccount(userId);
      return reply.code(204).send();
    } catch {
      return reply.code(500).send({
        error: { code: 500, message: 'Account deletion failed' },
      });
    }
  });
};

export default userRoutes;
