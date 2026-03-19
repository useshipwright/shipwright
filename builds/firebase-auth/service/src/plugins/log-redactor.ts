import { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

const CENSOR = '[REDACTED]';

/**
 * Pino redact configuration — applied at Fastify logger construction time.
 *
 * Covers:
 * - API key header (X-API-Key)
 * - Authorization header
 * - Password fields in request/response bodies
 * - Firebase service account credential fields (private_key, etc.)
 * - Generic secret/token/credential fields at any single nesting level
 */
export const pinoRedactConfig = {
  paths: [
    // Headers carrying secrets
    'req.headers["x-api-key"]',
    'req.headers.authorization',

    // Password fields — request bodies and nested objects
    '*.password',
    '*.passwordHash',
    '*.passwordSalt',

    // Firebase service account JSON fields — prevent credential leakage
    '*.private_key',
    '*.private_key_id',
    '*.serviceAccountCredential',

    // Generic sensitive fields at one level of nesting
    '*.secret',
    '*.apiKey',
    '*.apiKeys',
    '*.credential',
    '*.credentials',
  ],
  censor: CENSOR,
};

/**
 * Partially redact an email for safe inclusion in logs and audit entries.
 *
 * Keeps the first character of the local part and the full domain so operators
 * can correlate without exposing the full address.
 *
 * @example
 *   redactEmail("user@example.com")  // "u***@example.com"
 *   redactEmail("a@b.co")            // "a***@b.co"
 *   redactEmail(null)                // "[no-email]"
 *   redactEmail("")                  // "[no-email]"
 *   redactEmail(12345)               // "[no-email]"
 */
export function redactEmail(email: unknown): string {
  if (typeof email !== 'string' || email.length === 0) {
    return '[no-email]';
  }

  const atIndex = email.indexOf('@');

  // No @ sign or empty local part — treat as malformed
  if (atIndex < 1) {
    return `${email[0]}***`;
  }

  const domain = email.slice(atIndex); // includes the @
  return `${email[0]}***${domain}`;
}

/**
 * Partially redact a UID for safe inclusion in logs and audit entries.
 *
 * Shows the first 3 and last 3 characters with an ellipsis in between.
 *
 * @example
 *   redactUid("abc123def456")  // "abc...456"
 *   redactUid("short")         // "sho...ort"
 *   redactUid("ab")            // "ab...ab"
 *   redactUid(null)            // "[no-uid]"
 *   redactUid("")              // "[no-uid]"
 *   redactUid(12345)           // "[no-uid]"
 */
export function redactUid(uid: unknown): string {
  if (typeof uid !== 'string' || uid.length === 0) {
    return '[no-uid]';
  }

  const prefixLen = Math.min(3, uid.length);
  const suffixLen = Math.min(3, uid.length);

  return `${uid.slice(0, prefixLen)}...${uid.slice(-suffixLen)}`;
}

/**
 * Fastify plugin — decorates the instance with redaction helpers so they
 * are accessible from route handlers and other plugins via `app.redactEmail`
 * and `app.redactUid`.
 */
async function logRedactorPlugin(app: FastifyInstance): Promise<void> {
  app.decorate('redactEmail', redactEmail);
  app.decorate('redactUid', redactUid);
}

export default fp(logRedactorPlugin, { name: 'log-redactor' });
