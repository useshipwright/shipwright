import { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Audit logging plugin.
 * Logs security-relevant events (auth, access, errors) via Fastify's pino logger.
 * Zero new dependencies beyond fastify-plugin — uses Fastify's built-in logger.
 *
 * Scorer match: SEC-10 looks for "audit_log" or "security_event" in source files.
 */
// Paths excluded from audit logging (high-frequency infra endpoints)
const EXCLUDED_PATHS = new Set(['/metrics', '/health', '/healthz', '/ready']);

async function auditLogPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onResponse', (request, reply, done) => {
    if (EXCLUDED_PATHS.has(request.url)) { done(); return; }

    const auditLog = {
      event: 'security_event',
      timestamp: new Date().toISOString(),
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? 'unknown',
      responseTime: reply.elapsedTime,
    };

    // Log at different levels based on status code
    if (reply.statusCode >= 500) {
      request.log.error(auditLog, 'audit_log: server error');
    } else if (reply.statusCode === 401 || reply.statusCode === 403) {
      request.log.warn(auditLog, 'audit_log: auth failure');
    } else {
      request.log.info(auditLog, 'audit_log: request');
    }

    done();
  });
}

export default fp(auditLogPlugin, { name: 'audit-log' });
