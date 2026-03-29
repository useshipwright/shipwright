/**
 * AI route plugin — cross-meeting Q&A and meeting prep brief generation.
 *
 * POST /api/ai/ask   — RAG-based Q&A over meeting history
 * POST /api/ai/meeting-prep — Generate prep brief from past meetings
 *
 * Rate-limited at 10 req/min per user (inherits from AI tier rate limit plugin).
 * All responses use the standard envelope: { data: T }
 *
 * SECURITY:
 * - All queries scoped to authenticated userId
 * - Prompt injection mitigated via clearly delimited user content
 * - No secrets included in prompts (threat model: Anthropic API key exposure)
 */

import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

import {
  AiAskBodySchema,
  AiMeetingPrepBodySchema,
  type AiAskBody,
  type AiMeetingPrepBody,
} from '../types/api.js';
import type { AiQaService } from '../services/ai-qa.js';

// ── Plugin options ──────────────────────────────────────────────────

export interface AiRoutesOptions {
  aiQaService: AiQaService;
}

// ── Helper: convert Zod to Fastify JSON Schema ──────────────────────

function zodSchema(schema: z.ZodType): Record<string, unknown> {
  return (zodToJsonSchema as (...args: unknown[]) => Record<string, unknown>)(schema);
}

// ── Route plugin ────────────────────────────────────────────────────

const aiRoutes: FastifyPluginAsync<AiRoutesOptions> = async (
  app: FastifyInstance,
  opts: AiRoutesOptions,
) => {
  const { aiQaService } = opts;

  // ── POST /api/ai/ask ─────────────────────────────────────────────
  app.post<{ Body: AiAskBody }>(
    '/ask',
    {
      schema: {
        body: zodSchema(AiAskBodySchema),
      },
    },
    async (request, reply) => {
      const { question } = request.body;

      try {
        const result = await aiQaService.askQuestion({
          question,
          userId: request.userId,
        });

        return {
          data: {
            answer: result.answer,
            citations: result.citations,
            model: result.model,
            usage: {
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
            },
          },
        };
      } catch (err) {
        request.log.error({ err }, 'AI Q&A failed');
        return reply.status(503).send({
          error: {
            code: 503,
            message: 'AI service unavailable',
          },
        });
      }
    },
  );

  // ── POST /api/ai/meeting-prep ────────────────────────────────────
  app.post<{ Body: AiMeetingPrepBody }>(
    '/meeting-prep',
    {
      schema: {
        body: zodSchema(AiMeetingPrepBodySchema),
      },
    },
    async (request, reply) => {
      const { meetingId, attendeeEmails } = request.body;

      try {
        const result = await aiQaService.meetingPrep({
          userId: request.userId,
          meetingId,
          attendeeEmails,
        });

        return {
          data: {
            brief: result.brief,
            meetings: result.meetings,
            model: result.model,
            usage: {
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
            },
          },
        };
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 400 || statusCode === 404) {
          return reply.status(statusCode).send({
            error: {
              code: statusCode,
              message: (err as Error).message,
            },
          });
        }

        request.log.error({ err }, 'Meeting prep generation failed');
        return reply.status(503).send({
          error: {
            code: 503,
            message: 'AI service unavailable',
          },
        });
      }
    },
  );
};

export default aiRoutes;
