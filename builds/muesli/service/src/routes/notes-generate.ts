/**
 * AI note generation route plugin.
 *
 * Registers POST /api/meetings/:id/notes/generate endpoint.
 * Subject to AI-tier rate limiting (10 req/min).
 * All responses use the standard envelope: { data: T }
 */

import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

import { GenerateNotesBodySchema, IdParamSchema, type IdParam } from '../types/api.js';
import type { AiNotesService } from '../services/ai-notes.js';

// ── Plugin options ──────────────────────────────────────────────────

export interface NotesGenerateRoutesOptions {
  aiNotesService: AiNotesService;
}

// ── Helper: convert Zod to Fastify JSON Schema ──────────────────────

function zodSchema(schema: z.ZodType): Record<string, unknown> {
  return (zodToJsonSchema as (...args: unknown[]) => Record<string, unknown>)(schema);
}

// ── Extended body schema with model parameter ───────────────────────

const GenerateNotesBodyExtendedSchema = GenerateNotesBodySchema.extend({
  model: z.enum(['sonnet', 'opus']).optional(),
});

type GenerateNotesBodyExtended = z.infer<typeof GenerateNotesBodyExtendedSchema>;

// ── Route plugin ────────────────────────────────────────────────────

const notesGenerateRoutes: FastifyPluginAsync<NotesGenerateRoutesOptions> = async (
  app: FastifyInstance,
  opts: NotesGenerateRoutesOptions,
) => {
  const { aiNotesService } = opts;

  // ── POST /api/meetings/:id/notes/generate ─────────────────────────
  app.post<{ Params: IdParam; Body: GenerateNotesBodyExtended }>(
    '/:id/notes/generate',
    {
      schema: {
        params: zodSchema(IdParamSchema),
        body: zodSchema(GenerateNotesBodyExtendedSchema),
      },
    },
    async (request, reply) => {
      const result = await aiNotesService.generate({
        userId: request.userId,
        meetingId: request.params.id,
        templateId: request.body.templateId,
        model: request.body.model,
      });

      if (result === 'not_found') {
        return reply.code(404).send({
          error: { code: 404, message: 'Meeting not found' },
        });
      }

      if (result === 'no_transcript') {
        return reply.code(404).send({
          error: { code: 404, message: 'No transcript available for this meeting' },
        });
      }

      return reply.code(200).send({
        data: result.note,
        meta: {
          actionsExtracted: result.actionsExtracted,
          tagsGenerated: result.tagsGenerated,
        },
      });
    },
  );
};

export default notesGenerateRoutes;
