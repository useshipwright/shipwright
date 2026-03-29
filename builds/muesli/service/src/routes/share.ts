/**
 * Share route plugin — shareable meeting note links with access control.
 *
 * POST   /api/meetings/:id/share   — Create a share link (auth required)
 * GET    /api/share/:shareId       — View shared notes (access per share mode)
 * GET    /api/meetings/:id/shares  — List active shares for a meeting (auth required)
 * DELETE /api/share/:shareId       — Revoke a share link (owner only)
 *
 * SECURITY:
 * - Share IDs use 128-bit crypto randomness (crypto.randomUUID)
 * - Identical 404 for expired, revoked, and non-existent shares (no info leakage)
 * - Public shares bypass auth; authenticated/specific_emails enforce JWT
 * - Attendee emails stripped from shared view (names only)
 * - View count incremented on each valid access
 */

import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

import {
  CreateShareBodySchema,
  type CreateShareBody,
  IdParamSchema,
  type IdParam,
  ShareIdParamSchema,
} from '../types/api.js';
import type { ShareService } from '../services/share.js';

// ── Plugin options ──────────────────────────────────────────────────

export interface ShareRoutesOptions {
  shareService: ShareService;
}

// ── Helper: convert Zod to Fastify JSON Schema ──────────────────────

function zodSchema(schema: z.ZodType): Record<string, unknown> {
  return (zodToJsonSchema as (...args: unknown[]) => Record<string, unknown>)(schema);
}

// ── Share ID param schema ───────────────────────────────────────────

type ShareIdParam = z.infer<typeof ShareIdParamSchema>;

// ── Authenticated routes (under /api/meetings prefix) ──────────────

/**
 * Routes that require auth — creating shares and listing shares.
 * These are registered under the /api/meetings prefix.
 */
export const meetingShareRoutes: FastifyPluginAsync<ShareRoutesOptions> = async (
  app: FastifyInstance,
  opts: ShareRoutesOptions,
) => {
  const { shareService } = opts;

  // ── POST /api/meetings/:id/share ─────────────────────────────────
  app.post<{ Params: IdParam; Body: CreateShareBody }>(
    '/:id/share',
    {
      schema: {
        params: zodSchema(IdParamSchema),
        body: zodSchema(CreateShareBodySchema),
      },
    },
    async (request, reply) => {
      const { id: meetingId } = request.params;
      const { userId } = request;
      const body = request.body;

      // Validate specific_emails requires allowedEmails
      if (body.access === 'specific_emails' && (!body.allowedEmails || body.allowedEmails.length === 0)) {
        return reply.code(400).send({
          error: { code: 400, message: 'allowedEmails required for specific_emails access mode' },
        });
      }

      const share = await shareService.create({
        userId,
        meetingId,
        accessMode: body.access,
        allowedEmails: body.allowedEmails,
        includeTranscript: body.includeTranscript,
        includeAudio: body.includeAudio,
        expiresAt: body.expiresAt,
      });

      if (!share) {
        return reply.code(404).send({
          error: { code: 404, message: 'Meeting not found' },
        });
      }

      return reply.code(201).send({ data: share });
    },
  );

  // ── GET /api/meetings/:id/shares ─────────────────────────────────
  app.get<{ Params: IdParam }>(
    '/:id/shares',
    {
      schema: {
        params: zodSchema(IdParamSchema),
      },
    },
    async (request, reply) => {
      const { id: meetingId } = request.params;
      const { userId } = request;

      const shares = await shareService.listByMeeting(meetingId, userId);
      return reply.send({ data: shares });
    },
  );
};

// ── Public/share-access routes (under /api/share prefix) ───────────

/**
 * Routes for viewing and revoking shares.
 * GET is access-controlled per share mode (handled by auth middleware).
 * DELETE requires owner auth.
 */
const shareRoutes: FastifyPluginAsync<ShareRoutesOptions> = async (
  app: FastifyInstance,
  opts: ShareRoutesOptions,
) => {
  const { shareService } = opts;

  // ── GET /api/share/:shareId ──────────────────────────────────────
  app.get<{ Params: ShareIdParam }>(
    '/:shareId',
    {
      schema: {
        params: zodSchema(ShareIdParamSchema),
      },
    },
    async (request, reply) => {
      const { shareId } = request.params;

      // Auth middleware already handled access control for share routes.
      // If we reach here, the request is authorized.
      const viewData = await shareService.view(shareId);

      if (!viewData) {
        // Identical 404 for non-existent, expired, revoked shares
        return reply.code(404).send({
          error: { code: 404, message: 'Share not found' },
        });
      }

      return reply.send({ data: viewData });
    },
  );

  // ── DELETE /api/share/:shareId ───────────────────────────────────
  app.delete<{ Params: ShareIdParam }>(
    '/:shareId',
    {
      schema: {
        params: zodSchema(ShareIdParamSchema),
      },
    },
    async (request, reply) => {
      const { shareId } = request.params;
      const { userId } = request;

      // userId must be set (auth middleware ensures this for /api/* routes)
      if (!userId) {
        return reply.code(401).send({
          error: { code: 401, message: 'Authentication required' },
        });
      }

      const revoked = await shareService.revoke(shareId, userId);

      if (!revoked) {
        return reply.code(404).send({
          error: { code: 404, message: 'Share not found' },
        });
      }

      return reply.code(204).send();
    },
  );
};

export default shareRoutes;
