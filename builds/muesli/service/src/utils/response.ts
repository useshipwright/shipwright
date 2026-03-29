/**
 * Response envelope helpers per ADR-007.
 *
 * Standard response envelope: { data: T, meta?: { cursor, hasMore, warning } }
 * Standard error envelope:    { error: { code: number, message: string, details?: object } }
 *
 * Provides both standalone functions and a Fastify plugin that decorates
 * reply with envelope() and envelopeError() for consistent usage across
 * all 30+ endpoints.
 */

import fp from 'fastify-plugin';
import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyPluginAsync,
} from 'fastify';
import type { ApiResponse, ApiErrorResponse } from '../types/api.js';

// ── Response meta ────────────────────────────────────────────────────

export interface ResponseMeta {
  cursor?: string;
  hasMore?: boolean;
  warning?: string;
}

// ── Standalone helpers ───────────────────────────────────────────────

/**
 * Build a standard success envelope.
 */
export function envelope<T>(data: T, meta?: ResponseMeta): ApiResponse<T> {
  const response: ApiResponse<T> = { data };
  if (meta) {
    // Only include meta if at least one field is defined
    const filtered: ResponseMeta = {};
    if (meta.cursor !== undefined) filtered.cursor = meta.cursor;
    if (meta.hasMore !== undefined) filtered.hasMore = meta.hasMore;
    if (meta.warning !== undefined) filtered.warning = meta.warning;
    if (Object.keys(filtered).length > 0) {
      response.meta = filtered;
    }
  }
  return response;
}

/**
 * Build a standard error envelope.
 */
export function envelopeError(
  code: number,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorResponse {
  const err: ApiErrorResponse = {
    error: { code, message },
  };
  if (details !== undefined) {
    err.error.details = details;
  }
  return err;
}

// ── Fastify plugin ──────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyReply {
    envelope: <T>(data: T, meta?: ResponseMeta) => FastifyReply;
    envelopeError: (
      code: number,
      message: string,
      details?: Record<string, unknown>,
    ) => FastifyReply;
  }
}

const responseEnvelopePlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.decorateReply('envelope', function <T>(this: FastifyReply, data: T, meta?: ResponseMeta) {
    return this.send(envelope(data, meta));
  });

  app.decorateReply(
    'envelopeError',
    function (
      this: FastifyReply,
      code: number,
      message: string,
      details?: Record<string, unknown>,
    ) {
      return this.code(code).send(envelopeError(code, message, details));
    },
  );
};

export default fp(responseEnvelopePlugin, {
  name: 'response-envelope',
  fastify: '5.x',
});
