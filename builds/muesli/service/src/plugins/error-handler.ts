import { type FastifyInstance, type FastifyError } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { envelopeError } from '../utils/response.js';

// ── Helpers ─────────────────────────────────────────────────────────

/** Firestore-style document IDs that should never appear in responses. */
const INTERNAL_ID_PATTERN = /\b[a-zA-Z0-9]{20,}\b/g;

const isProduction = config.nodeEnv === 'production';

/**
 * Extract field-level validation details from Fastify/Ajv validation errors.
 * Fastify sets `error.validation` for schema validation failures.
 */
function extractValidationDetails(
  error: FastifyError,
): Record<string, unknown> | undefined {
  const validation = (error as FastifyError & { validation?: unknown[] }).validation;
  if (!Array.isArray(validation) || validation.length === 0) return undefined;

  const fields: Record<string, string> = {};
  for (const issue of validation) {
    const v = issue as {
      instancePath?: string;
      params?: { missingProperty?: string };
      message?: string;
      keyword?: string;
    };
    const path =
      v.instancePath?.replace(/^\//, '').replace(/\//g, '.') ||
      v.params?.missingProperty ||
      'unknown';
    fields[path] = v.message ?? v.keyword ?? 'invalid';
  }
  return { fields };
}

/**
 * Sanitise a user-facing error message:
 * - Strip internal document IDs (20+ char alphanumeric strings)
 * - Remove file paths
 */
function sanitiseMessage(msg: string): string {
  return msg
    .replace(/\/[^\s]+\.[jt]sx?:\d+/g, '[internal]')
    .replace(INTERNAL_ID_PATTERN, '[id]');
}

// ── Plugin ──────────────────────────────────────────────────────────

async function errorHandlerPlugin(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    // Always log the full error with stack trace for observability
    request.log.error({ err: error, statusCode }, 'Request error');

    // Fastify validation errors (Ajv / Zod-to-JSON-Schema)
    if (error.validation) {
      const details = extractValidationDetails(error);
      const validationPart = error.validationContext
        ? ` (${error.validationContext})`
        : '';

      return reply
        .status(400)
        .send(
          envelopeError(
            400,
            `Validation failed${validationPart}`,
            details,
          ),
        );
    }

    // Known client errors (4xx) — return sanitised message
    if (statusCode >= 400 && statusCode < 500) {
      return reply
        .status(statusCode)
        .send(envelopeError(statusCode, sanitiseMessage(error.message)));
    }

    // Server errors (5xx) — never leak internal details
    const message = isProduction
      ? 'Internal Server Error'
      : sanitiseMessage(error.message);

    return reply.status(statusCode).send(envelopeError(statusCode, message));
  });
}

export default fp(errorHandlerPlugin, {
  name: 'error-handler',
  fastify: '5.x',
});
