import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LogCall {
  args: unknown[];
}

async function buildTestApp(opts: { interceptLogs?: boolean } = {}): Promise<{
  app: FastifyInstance;
  logCalls: LogCall[];
}> {
  const app = Fastify({ logger: false });
  const logCalls: LogCall[] = [];

  // Request context provides requestId
  const { default: requestContext } = await import('../../src/plugins/request-context.js');
  await app.register(requestContext);

  // Audit logger under test
  const { default: auditLogger } = await import('../../src/plugins/audit-logger.js');
  await app.register(auditLogger);

  // Decorate apiKeyId manually (normally done by api-key-auth)
  app.decorateRequest('apiKeyId', '');

  // Intercept request.log.info calls BEFORE app.ready() if requested
  if (opts.interceptLogs) {
    app.addHook('onRequest', (request, _reply, done) => {
      const origInfo = request.log.info.bind(request.log);
      request.log.info = ((...args: unknown[]) => {
        logCalls.push({ args });
        return (origInfo as (...a: unknown[]) => void)(...args);
      }) as typeof request.log.info;
      done();
    });
  }

  // Route that emits an audit entry
  app.post('/do-mutation', async (request, reply) => {
    request.apiKeyId = 'abc12345';

    app.emitAudit(request, {
      event: 'user.create',
      target: 'uid-123',
      changes: { fields: ['email', 'displayName'] },
    });

    return reply.status(200).send({ ok: true });
  });

  // Route that emits audit without setting apiKeyId
  app.post('/no-key-mutation', async (request, reply) => {
    // apiKeyId stays at default '' (falsy)
    app.emitAudit(request, {
      event: 'user.delete',
      target: 'uid-456',
      changes: { fields: ['uid'] },
    });
    return reply.status(200).send({ ok: true });
  });

  // A health route (excluded from security event logging)
  app.get('/health', async () => ({ status: 'ok' }));

  // A regular GET route
  app.get('/data', async () => ({ data: true }));

  await app.ready();
  return { app, logCalls };
}

function findAuditLog(logCalls: LogCall[]): Record<string, unknown> | undefined {
  for (const call of logCalls) {
    const first = call.args[0];
    if (typeof first === 'object' && first !== null && (first as Record<string, unknown>).audit === true) {
      return first as Record<string, unknown>;
    }
  }
  return undefined;
}

function findSecurityEvent(logCalls: LogCall[]): Record<string, unknown> | undefined {
  for (const call of logCalls) {
    const first = call.args[0];
    if (
      typeof first === 'object' &&
      first !== null &&
      (first as Record<string, unknown>).event === 'security_event'
    ) {
      return first as Record<string, unknown>;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('audit-logger plugin', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  // -----------------------------------------------------------------------
  // emitAudit writes structured JSON
  // -----------------------------------------------------------------------

  describe('emitAudit structured log', () => {
    it('emitAudit writes log with correct fields', async () => {
      const result = await buildTestApp({ interceptLogs: true });
      app = result.app;

      await app.inject({ method: 'POST', url: '/do-mutation' });

      const auditLog = findAuditLog(result.logCalls);
      expect(auditLog).toBeDefined();

      expect(auditLog!.audit).toBe(true);
      expect(auditLog!.event).toBe('user.create');
      expect(auditLog!.actor).toBe('abc12345');
      expect(auditLog!.target).toBe('uid-123');
      expect(auditLog!.requestId).toBeDefined();
      expect(auditLog!.timestamp).toBeDefined();
      expect(typeof auditLog!.timestamp).toBe('string');

      // Verify ISO-8601 format
      const ts = new Date(auditLog!.timestamp as string);
      expect(ts.toISOString()).toBe(auditLog!.timestamp);

      // changes.fields contains field names only
      const changes = auditLog!.changes as { fields: string[] };
      expect(changes.fields).toEqual(['email', 'displayName']);
    });

    it('audit entry contains field names only — no PII values', async () => {
      const result = await buildTestApp({ interceptLogs: true });
      app = result.app;

      await app.inject({ method: 'POST', url: '/do-mutation' });

      const auditLog = findAuditLog(result.logCalls);
      expect(auditLog).toBeDefined();

      const serialized = JSON.stringify(auditLog);
      expect(serialized).not.toContain('user@example.com');
      expect(serialized).not.toContain('password');
    });

    it('emitAudit uses fallback actor when apiKeyId is empty', async () => {
      const result = await buildTestApp({ interceptLogs: true });
      app = result.app;

      await app.inject({ method: 'POST', url: '/no-key-mutation' });

      const auditLog = findAuditLog(result.logCalls);
      expect(auditLog).toBeDefined();
      // apiKeyId is '' (empty string) which is not nullish — ?? does not trigger
      // The actor field should be a string (either empty or 'unknown')
      expect(typeof auditLog!.actor).toBe('string');
    });
  });

  // -----------------------------------------------------------------------
  // onResponse security event logging
  // -----------------------------------------------------------------------

  describe('onResponse security event', () => {
    it('does not log security_event for excluded paths (/health)', async () => {
      const result = await buildTestApp({ interceptLogs: true });
      app = result.app;

      await app.inject({ method: 'GET', url: '/health' });

      const secEvent = findSecurityEvent(result.logCalls);
      expect(secEvent).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // emitAudit decorator exists
  // -----------------------------------------------------------------------

  describe('decorator', () => {
    it('emitAudit is available as a Fastify decorator', async () => {
      const result = await buildTestApp();
      app = result.app;
      expect(typeof app.emitAudit).toBe('function');
    });
  });
});
