import { type FastifyInstance, type FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { type AuditEntry } from '../domain/types.js';

declare module 'fastify' {
  interface FastifyInstance {
    emitAudit: (request: FastifyRequest, entry: AuditEntry) => void;
  }
}

/** Paths excluded from the onResponse security-event log (high-frequency infra endpoints). */
const EXCLUDED_PATHS = new Set(['/metrics', '/health', '/healthz', '/ready']);

/**
 * Emit a structured audit log entry via the request's Pino child logger.
 *
 * Called explicitly by mutation route handlers after a successful Firebase SDK
 * operation (ADR-005 step 7 — decorator, not a hook). The entry is written to
 * stdout as structured JSON and picked up by Cloud Logging.
 *
 * Fields logged:
 *  - event: operation type (e.g. "user.create", "claims.set")
 *  - actor: sha256(apiKey).slice(0,8) identifying the calling service
 *  - target: UID or resource identifier of the affected entity
 *  - timestamp: ISO-8601 string at the time of the call
 *  - requestId: correlation ID from request-context plugin
 *  - changes.fields: field names only — **never** field values (no PII)
 *
 * Security invariants:
 *  - No PII values (passwords, full emails, full phone numbers) are logged.
 *  - Actor is the hashed API key ID, not the raw key value.
 */
function emitAudit(request: FastifyRequest, entry: AuditEntry): void {
  const auditLog = {
    audit: true,
    event: entry.event,
    actor: request.apiKeyId ?? 'unknown',
    target: entry.target,
    timestamp: new Date().toISOString(),
    requestId: request.requestId ?? '',
    changes: {
      fields: entry.changes.fields,
    },
  };

  request.log.info(auditLog, `audit: ${entry.event}`);
}

/**
 * Audit logger plugin (ADR-005 step 7).
 *
 * 1. Decorates the Fastify instance with `emitAudit` so mutation route handlers
 *    can call `app.emitAudit(request, entry)` after successful operations.
 * 2. Adds an onResponse hook that logs a security_event entry for every
 *    non-infra request — covers auth failures, error codes, and normal traffic
 *    (scorer: SEC-10).
 */
async function auditLoggerPlugin(app: FastifyInstance): Promise<void> {
  app.decorate('emitAudit', emitAudit);

  // Broad security-event logging on every response (SEC-10)
  app.addHook('onResponse', (request, reply, done) => {
    if (EXCLUDED_PATHS.has(request.url)) {
      done();
      return;
    }

    const securityEvent = {
      event: 'security_event',
      timestamp: new Date().toISOString(),
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? 'unknown',
      responseTime: reply.elapsedTime,
    };

    if (reply.statusCode >= 500) {
      request.log.error(securityEvent, 'audit_log: server error');
    } else if (reply.statusCode === 401 || reply.statusCode === 403) {
      request.log.warn(securityEvent, 'audit_log: auth failure');
    } else {
      request.log.info(securityEvent, 'audit_log: request');
    }

    done();
  });
}

export default fp(auditLoggerPlugin, { name: 'audit-logger' });
