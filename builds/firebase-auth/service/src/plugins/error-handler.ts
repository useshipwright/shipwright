import { type FastifyInstance, type FastifyError } from 'fastify';
import fp from 'fastify-plugin';
import type { ErrorResponse } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Firebase error code → HTTP status mapping
// ---------------------------------------------------------------------------

/** Exact-match Firebase error codes to HTTP status codes. */
const EXACT_CODE_MAP: Record<string, number> = {
  'auth/user-not-found': 404,
  'auth/id-token-expired': 401,
  'auth/id-token-revoked': 401,
  'auth/argument-error': 400,
  'auth/insufficient-permission': 500,
  'auth/quota-exceeded': 503,
  'auth/internal-error': 502,
};

/** Status codes that receive a generic client-facing message (no info leakage). */
const GENERIC_MESSAGE_CODES = new Set([401, 403]);

const GENERIC_MESSAGES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  500: 'Internal server error',
  502: 'Bad gateway',
  503: 'Service unavailable',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether an error originates from the Firebase Admin SDK.
 * Firebase errors expose a `code` string in the shape "auth/<detail>".
 */
function isFirebaseError(err: unknown): err is { code: string; message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as Record<string, unknown>).code === 'string' &&
    ((err as Record<string, unknown>).code as string).startsWith('auth/')
  );
}

/**
 * Detect network-level errors (ECONNREFUSED, ETIMEDOUT, etc.)
 * that indicate the upstream Firebase service is unreachable.
 */
function isNetworkError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as Record<string, unknown>).code;
  if (typeof code !== 'string') return false;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  );
}

/**
 * Check if the error is a Fastify validation error (e.g. schema validation).
 */
function isFastifyValidationError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'validation' in err &&
    Array.isArray((err as Record<string, unknown>).validation)
  );
}

/**
 * Resolve an HTTP status code from a Firebase error code.
 * Checks exact matches first, then prefix patterns.
 */
function resolveFirebaseStatus(firebaseCode: string): number {
  // Exact match
  const exact = EXACT_CODE_MAP[firebaseCode];
  if (exact !== undefined) return exact;

  // auth/invalid-* → 400
  if (firebaseCode.startsWith('auth/invalid-')) return 400;

  // auth/email-already-exists, auth/phone-number-already-exists → 409
  if (firebaseCode === 'auth/email-already-exists') return 409;
  if (firebaseCode === 'auth/phone-number-already-exists') return 409;

  // Default unknown Firebase errors → 500
  return 500;
}

/**
 * Build the standard error response envelope per ADR-006.
 */
function buildErrorResponse(
  statusCode: number,
  message: string,
  requestId: string,
): ErrorResponse {
  return {
    error: {
      code: statusCode,
      message,
      requestId,
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

async function errorHandlerPlugin(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err: FastifyError | Error, request, reply) => {
    const requestId: string =
      (request as { requestId?: string }).requestId || '';

    let statusCode: number;
    let clientMessage: string;

    if (isFastifyValidationError(err)) {
      // Fastify schema validation error → 400
      statusCode = 400;
      clientMessage = (err as FastifyError).message || 'Validation error';

      request.log.warn(
        { err, statusCode },
        'Request validation failed',
      );
    } else if (isFirebaseError(err)) {
      // Firebase Admin SDK error
      statusCode = resolveFirebaseStatus(err.code);

      request.log.error(
        { err, firebaseCode: err.code, statusCode },
        'Firebase SDK error',
      );

      // Generic messages for 401/403 to prevent info leakage
      clientMessage = GENERIC_MESSAGE_CODES.has(statusCode)
        ? (GENERIC_MESSAGES[statusCode] ?? 'Error')
        : (GENERIC_MESSAGES[statusCode] ?? err.message);
    } else if (isNetworkError(err)) {
      // Network error reaching upstream → 502 (ADR-007)
      statusCode = 502;
      clientMessage = GENERIC_MESSAGES[502]!;

      request.log.error(
        { err, statusCode },
        'Network error communicating with upstream service',
      );
    } else {
      // Catch-all: use existing statusCode if set, otherwise 500
      statusCode =
        ('statusCode' in err && typeof (err as FastifyError).statusCode === 'number')
          ? (err as FastifyError).statusCode!
          : 500;

      request.log.error(
        { err, statusCode },
        'Unhandled error',
      );

      // Generic message for 401/403; otherwise use error message or generic 500
      clientMessage = GENERIC_MESSAGE_CODES.has(statusCode)
        ? (GENERIC_MESSAGES[statusCode] ?? 'Error')
        : (statusCode >= 500
            ? (GENERIC_MESSAGES[statusCode] ?? 'Internal server error')
            : ((err as Error).message || 'Internal server error'));
    }

    const body = buildErrorResponse(statusCode, clientMessage, requestId);
    void reply.status(statusCode).send(body);
  });
}

export default fp(errorHandlerPlugin, { name: 'error-handler' });
