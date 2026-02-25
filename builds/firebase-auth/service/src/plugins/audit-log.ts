import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

const EXCLUDED_PATHS = new Set(['/health', '/healthz', '/ready', '/metrics']);

async function auditLogPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onResponse', async (request, reply) => {
    if (EXCLUDED_PATHS.has(request.url)) return;

    const entry = {
      type: 'audit_log',
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime,
      correlationId: request.correlationId,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    };

    const status = reply.statusCode;
    if (status >= 500) {
      request.log.error(entry, 'audit_log');
    } else if (status === 401 || status === 403) {
      request.log.warn(entry, 'audit_log');
    } else {
      request.log.info(entry, 'audit_log');
    }
  });
}

export default fp(auditLogPlugin, {
  name: 'audit-log',
  dependencies: ['correlation-id', 'logging'],
});
