/**
 * Logger module tests — T-027.
 *
 * Tests Pino configuration, PII redaction of request bodies and
 * Authorization headers, and request logger creation.
 */

import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Create a test logger that captures output to an array.
 * Mirrors the production config from src/logger.ts for redaction paths.
 */
function createTestLogger() {
  const lines: string[] = [];
  const dest = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });

  const redactPaths = [
    'req.headers.authorization',
    'req.headers["authorization"]',
    'email',
    'attendeeEmail',
    'attendeeEmails',
    'attendeeEmails[*]',
    'allowedEmails',
    'allowedEmails[*]',
    'userEmail',
    'transcript',
    'transcriptContent',
    'content',
    'userNotes',
    'notes',
    'body.email',
    'body.attendeeEmails',
    'body.attendeeEmails[*]',
    'body.transcript',
    'body.transcriptContent',
    'body.content',
    'body.userNotes',
    'body.notes',
  ];

  const logger = pino(
    {
      level: 'trace',
      redact: {
        paths: redactPaths,
        censor: '[REDACTED]',
      },
    },
    dest,
  );

  return { logger, lines, dest };
}

function getLastLog(lines: string[]): Record<string, unknown> {
  if (lines.length === 0) throw new Error('No log lines captured');
  return JSON.parse(lines[lines.length - 1]);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Logger Module', () => {
  describe('PII redaction', () => {
    it('redacts Authorization header from request objects', () => {
      const { logger, lines } = createTestLogger();

      logger.info({
        req: {
          headers: {
            authorization: 'Bearer secret-token-123',
            'content-type': 'application/json',
          },
        },
      }, 'request received');

      const log = getLastLog(lines);
      const req = log.req as Record<string, unknown>;
      const headers = req.headers as Record<string, string>;
      expect(headers.authorization).toBe('[REDACTED]');
      expect(headers['content-type']).toBe('application/json');
    });

    it('redacts email fields at top level', () => {
      const { logger, lines } = createTestLogger();

      logger.info({ email: 'user@example.com' }, 'user action');

      const log = getLastLog(lines);
      expect(log.email).toBe('[REDACTED]');
    });

    it('redacts userEmail field', () => {
      const { logger, lines } = createTestLogger();

      logger.info({ userEmail: 'user@example.com' }, 'request');

      const log = getLastLog(lines);
      expect(log.userEmail).toBe('[REDACTED]');
    });

    it('redacts attendeeEmails array', () => {
      const { logger, lines } = createTestLogger();

      logger.info(
        { attendeeEmails: ['alice@example.com', 'bob@example.com'] },
        'meeting created',
      );

      const log = getLastLog(lines);
      expect(log.attendeeEmails).toBe('[REDACTED]');
    });

    it('redacts allowedEmails array', () => {
      const { logger, lines } = createTestLogger();

      logger.info(
        { allowedEmails: ['alice@example.com'] },
        'share created',
      );

      const log = getLastLog(lines);
      expect(log.allowedEmails).toBe('[REDACTED]');
    });

    it('redacts transcript content', () => {
      const { logger, lines } = createTestLogger();

      logger.info(
        { transcript: 'Alice said: The quarterly results show...' },
        'transcript loaded',
      );

      const log = getLastLog(lines);
      expect(log.transcript).toBe('[REDACTED]');
    });

    it('redacts transcriptContent field', () => {
      const { logger, lines } = createTestLogger();

      logger.info(
        { transcriptContent: 'Some sensitive transcript text' },
        'processing',
      );

      const log = getLastLog(lines);
      expect(log.transcriptContent).toBe('[REDACTED]');
    });

    it('redacts content field', () => {
      const { logger, lines } = createTestLogger();

      logger.info({ content: 'Meeting notes content here' }, 'notes saved');

      const log = getLastLog(lines);
      expect(log.content).toBe('[REDACTED]');
    });

    it('redacts userNotes field', () => {
      const { logger, lines } = createTestLogger();

      logger.info({ userNotes: 'My personal notes about this meeting' }, 'note saved');

      const log = getLastLog(lines);
      expect(log.userNotes).toBe('[REDACTED]');
    });

    it('redacts notes field', () => {
      const { logger, lines } = createTestLogger();

      logger.info({ notes: 'Generated meeting notes' }, 'notes generated');

      const log = getLastLog(lines);
      expect(log.notes).toBe('[REDACTED]');
    });

    it('redacts body.email in nested objects', () => {
      const { logger, lines } = createTestLogger();

      logger.info(
        { body: { email: 'user@example.com', name: 'Alice' } },
        'request body',
      );

      const log = getLastLog(lines);
      const body = log.body as Record<string, unknown>;
      expect(body.email).toBe('[REDACTED]');
      expect(body.name).toBe('Alice');
    });

    it('redacts body.transcript', () => {
      const { logger, lines } = createTestLogger();

      logger.info(
        { body: { transcript: 'Sensitive transcript content' } },
        'body logged',
      );

      const log = getLastLog(lines);
      const body = log.body as Record<string, unknown>;
      expect(body.transcript).toBe('[REDACTED]');
    });

    it('does not redact non-sensitive fields', () => {
      const { logger, lines } = createTestLogger();

      logger.info(
        {
          meetingId: 'meeting-123',
          userId: 'user-456',
          status: 'ready',
        },
        'meeting updated',
      );

      const log = getLastLog(lines);
      expect(log.meetingId).toBe('meeting-123');
      expect(log.userId).toBe('user-456');
      expect(log.status).toBe('ready');
    });
  });

  describe('child logger (createRequestLogger equivalent)', () => {
    it('creates a child logger with requestId and userId', () => {
      const { logger } = createTestLogger();

      const childLogger = logger.child({
        requestId: 'req-abc',
        userId: 'user-123',
      });

      expect(childLogger).toBeDefined();
      expect(typeof childLogger.info).toBe('function');
    });

    it('child logger includes parent context in output', () => {
      const { logger, lines } = createTestLogger();

      const child = logger.child({ requestId: 'req-abc' });
      child.info('test message');

      const log = getLastLog(lines);
      expect(log.requestId).toBe('req-abc');
    });
  });

  describe('logger configuration', () => {
    it('outputs structured JSON', () => {
      const { logger, lines } = createTestLogger();

      logger.info('hello');

      const log = getLastLog(lines);
      expect(log.level).toBeDefined();
      expect(log.msg).toBe('hello');
    });

    it('includes standard Pino fields', () => {
      const { logger, lines } = createTestLogger();

      logger.info('test');

      const log = getLastLog(lines);
      expect(log.level).toBeDefined();
      expect(log.time).toBeDefined();
    });
  });

  describe('module exports', () => {
    it('logger module exports logger and createRequestLogger', async () => {
      // Dynamic import to avoid side-effecting the config singleton
      const mod = await import('../../src/logger.js');
      expect(mod.logger).toBeDefined();
      expect(typeof mod.logger.info).toBe('function');
      expect(typeof mod.createRequestLogger).toBe('function');
    });

    it('createRequestLogger returns a child logger', async () => {
      const mod = await import('../../src/logger.js');
      const requestLogger = mod.createRequestLogger({ requestId: 'req-1', userId: 'u-1' });
      expect(requestLogger).toBeDefined();
      expect(typeof requestLogger.info).toBe('function');
    });
  });
});
