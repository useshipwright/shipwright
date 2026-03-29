/**
 * Search route plugin.
 *
 * Registers GET /api/search (full-text) and GET /api/search/semantic endpoints
 * with Zod-validated schemas converted to JSON Schema for Fastify (ADR-011).
 *
 * All responses use the standard envelope: { data: T, meta?: { cursor, hasMore } }
 */

import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  SearchQuerySchema,
  SemanticSearchQuerySchema,
  type SearchQuery,
  type SemanticSearchQuery,
} from '../types/api.js';
import type { SearchService } from '../services/search.js';

// ── Plugin options ──────────────────────────────────────────────────

export interface SearchRoutesOptions {
  searchService: SearchService;
}

// ── Helper: convert Zod to Fastify JSON Schema ──────────────────────

function zodSchema(schema: z.ZodType): Record<string, unknown> {
  return (zodToJsonSchema as (...args: unknown[]) => Record<string, unknown>)(schema);
}

// ── Route plugin ────────────────────────────────────────────────────

const searchRoutes: FastifyPluginAsync<SearchRoutesOptions> = async (
  app: FastifyInstance,
  opts: SearchRoutesOptions,
) => {
  const { searchService } = opts;

  // ── GET /api/search ─────────────────────────────────────────────
  app.get<{ Querystring: SearchQuery }>(
    '/',
    {
      schema: {
        querystring: zodSchema(SearchQuerySchema),
      },
    },
    async (request) => {
      const q = request.query;
      const result = await searchService.fullTextSearch({
        query: q.q,
        userId: request.userId,
        type: q.type,
        cursor: q.cursor,
        limit: q.limit,
      });

      return {
        data: {
          meetings: result.meetings,
          actions: result.actions,
        },
        meta: {
          cursor: result.cursor,
          hasMore: result.hasMore,
        },
      };
    },
  );

  // ── GET /api/search/semantic ────────────────────────────────────
  app.get<{ Querystring: SemanticSearchQuery }>(
    '/semantic',
    {
      schema: {
        querystring: zodSchema(SemanticSearchQuerySchema),
      },
    },
    async (request, reply) => {
      const q = request.query;

      try {
        const result = await searchService.semanticSearch({
          query: q.q,
          userId: request.userId,
          limit: q.limit,
          filters: {
            meetingId: q.meetingId,
            sourceType: q.source,
          },
        });

        return {
          data: result.results,
          meta: {
            hasMore: false,
          },
        };
      } catch (err) {
        // Graceful degradation when Embedding Adapter fails
        request.log.error(
          { err },
          'Semantic search failed — embedding adapter error',
        );
        return reply.status(503).send({
          error: {
            code: 503,
            message: 'Embedding service unavailable',
          },
        });
      }
    },
  );
};

export default searchRoutes;
