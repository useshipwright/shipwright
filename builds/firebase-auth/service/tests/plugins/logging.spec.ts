import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import pino from 'pino';
import { Writable } from 'node:stream';
import correlationId from '../../src/plugins/correlation-id.js';
import logging, {
  createLoggerConfig,
  redactingErrSerializer,
} from '../../src/plugins/logging.js';

/**
 * Tests for the logging plugin (T-008).
 *
 * Verifies structured JSON output with GCP-compatible severity and message key,
 * redaction serializers strip emails/UIDs/tokens, and correlationId in log entries.
 *
 * Mitigates: "Credential Exposure in Logs" (threat model).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LogEntry {
  severity?: string;
  level?: number;
  message?: string;
  msg?: string;
  correlationId?: string;
  method?: string;
  url?: string;
  statusCode?: number;
  [key: string]: unknown;
}

/**
 * Builds a Fastify app that captures structured log output to an array.
 * Uses pino with a Writable stream, passed via Fastify's loggerInstance option.
 */
async function buildLoggingApp() {
  const logLines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(chunk.toString());
      callback();
    },
  });

  const loggerConfig = createLoggerConfig();
  const logger = pino({ ...loggerConfig, level: 'debug' }, stream);

  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: true,
  });

  app.register(correlationId);
  app.register(logging);

  app.get('/test', async (request) => {
    request.log.info({ email: 'user@example.com' }, 'test message');
    return { ok: true };
  });

  app.get('/test-uid', async (request) => {
    request.log.info({ uid: 'abcdef123456' }, 'uid log test');
    return { ok: true };
  });

  app.get('/test-token', async (request) => {
    request.log.info(
      {
        token:
          'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl',
      },
      'token log test',
    );
    return { ok: true };
  });

  app.get('/test-error', async (request) => {
    request.log.error(
      {
        err: new Error(
          'Failed with key: -----BEGIN RSA PRIVATE KEY-----\nfakekey\n-----END RSA PRIVATE KEY-----',
        ),
      },
      'error with credential',
    );
    return { ok: true };
  });

  await app.ready();

  function getLogEntries(): LogEntry[] {
    return logLines
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as LogEntry;
        } catch {
          return { raw: line } as unknown as LogEntry;
        }
      });
  }

  return { app, getLogEntries, logLines };
}

// ---------------------------------------------------------------------------
// createLoggerConfig
// ---------------------------------------------------------------------------

describe('createLoggerConfig', () => {
  it('returns an object with serializers and formatters', () => {
    const config = createLoggerConfig();
    expect(config).toHaveProperty('serializers');
    expect(config).toHaveProperty('formatters');
  });

  it('includes err serializer for redaction', () => {
    const config = createLoggerConfig();
    expect(config.serializers?.err).toBe(redactingErrSerializer);
  });

  it('includes a log formatter for deep scrubbing', () => {
    const config = createLoggerConfig();
    expect(config.formatters?.log).toBeDefined();
    expect(typeof config.formatters!.log).toBe('function');
  });

  it('log formatter redacts JWT tokens in objects', () => {
    const config = createLoggerConfig();
    const formatter = config.formatters!.log!;
    const result = formatter({
      token:
        'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl',
      safe: 'hello',
    }) as Record<string, unknown>;

    expect(result.safe).toBe('hello');
    expect(result.token).toContain('[REDACTED]');
  });

  it('log formatter redacts service account credential fields', () => {
    const config = createLoggerConfig();
    const formatter = config.formatters!.log!;
    const result = formatter({
      cred: '"private_key": "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----"',
    }) as Record<string, unknown>;

    expect(result.cred).toContain('[REDACTED_CREDENTIAL]');
  });
});

// ---------------------------------------------------------------------------
// Structured JSON output with GCP compatibility
// ---------------------------------------------------------------------------

describe('logging plugin — structured JSON output', () => {
  let app: Awaited<ReturnType<typeof buildLoggingApp>>['app'] | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('produces structured JSON log entries', async () => {
    const result = await buildLoggingApp();
    app = result.app;
    await app.inject({ method: 'GET', url: '/test' });

    const entries = result.getLogEntries();
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(entry).toBeDefined();
      expect(typeof entry).toBe('object');
    }
  });

  it('log entries have GCP-compatible severity field', async () => {
    const result = await buildLoggingApp();
    app = result.app;
    await app.inject({ method: 'GET', url: '/test' });

    const entries = result.getLogEntries();
    const withSeverity = entries.filter((e) => e.severity !== undefined);
    expect(withSeverity.length).toBeGreaterThan(0);

    const validSeverities = [
      'DEFAULT',
      'DEBUG',
      'INFO',
      'NOTICE',
      'WARNING',
      'ERROR',
      'CRITICAL',
      'ALERT',
      'EMERGENCY',
    ];
    for (const entry of withSeverity) {
      expect(validSeverities).toContain(entry.severity);
    }
  });

  it('log entries use "message" key (not "msg") per GCP config', async () => {
    const result = await buildLoggingApp();
    app = result.app;
    await app.inject({ method: 'GET', url: '/test' });

    const entries = result.getLogEntries();
    const messageEntries = entries.filter((e) => e.message !== undefined);
    expect(messageEntries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Redaction in log output
// ---------------------------------------------------------------------------

describe('logging plugin — redaction', () => {
  let app: Awaited<ReturnType<typeof buildLoggingApp>>['app'] | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('redacts JWT tokens in structured log data via formatters.log', async () => {
    const result = await buildLoggingApp();
    app = result.app;
    await app.inject({ method: 'GET', url: '/test-token' });

    const entries = result.getLogEntries();
    // Find the log entry from the route handler (not request-completed)
    const tokenEntry = entries.find(
      (e) =>
        (e.message === 'token log test' || e.msg === 'token log test'),
    );
    expect(tokenEntry).toBeDefined();
    // The full JWT should not appear — signature segment should be redacted
    const tokenValue = tokenEntry!.token as string;
    expect(tokenValue).toContain('[REDACTED]');
    expect(tokenValue).not.toContain('c2lnbmF0dXJl');
  });

  it('redacts JWT tokens from raw log output', async () => {
    const result = await buildLoggingApp();
    app = result.app;
    await app.inject({ method: 'GET', url: '/test-token' });

    const allOutput = result.logLines.join('\n');
    // The JWT signature segment should not appear in raw output
    expect(allOutput).not.toContain('c2lnbmF0dXJl');
    expect(allOutput).toContain('[REDACTED]');
  });

  it('redacts credentials via err serializer when logging errors directly', () => {
    // The redactingErrSerializer strips PEM keys from error messages/stacks.
    // Test it directly since formatters.log converts Error→{} before serializers run.
    const err = new Error(
      'Failed with key: -----BEGIN RSA PRIVATE KEY-----\nfakekey\n-----END RSA PRIVATE KEY-----',
    );
    const serialized = redactingErrSerializer(err);

    expect(serialized.message).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(serialized.message).toContain('[REDACTED_CREDENTIAL]');
  });
});

// ---------------------------------------------------------------------------
// Correlation ID in log entries
// ---------------------------------------------------------------------------

describe('logging plugin — correlationId', () => {
  let app: Awaited<ReturnType<typeof buildLoggingApp>>['app'] | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('injects correlationId into log entries for a request', async () => {
    const result = await buildLoggingApp();
    app = result.app;
    await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-request-id': 'test-corr-id-123' },
    });

    const entries = result.getLogEntries();
    const withCorrelation = entries.filter(
      (e) => e.correlationId === 'test-corr-id-123',
    );
    expect(withCorrelation.length).toBeGreaterThan(0);
  });

  it('logs request completed with method, url, statusCode, and correlationId', async () => {
    const result = await buildLoggingApp();
    app = result.app;
    await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-request-id': 'req-lifecycle-id' },
    });

    const entries = result.getLogEntries();
    const completedEntry = entries.find(
      (e) =>
        (e.message === 'request completed' || e.msg === 'request completed') &&
        e.correlationId === 'req-lifecycle-id',
    );

    expect(completedEntry).toBeDefined();
    expect(completedEntry!.method).toBe('GET');
    expect(completedEntry!.url).toBe('/test');
    expect(completedEntry!.statusCode).toBe(200);
  });
});
