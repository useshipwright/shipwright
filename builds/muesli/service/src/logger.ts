import pino, { type Logger, type LoggerOptions } from 'pino';
import { config } from './config.js';

const redactPaths = [
  // Authorization headers
  'req.headers.authorization',
  'req.headers["authorization"]',
  // Email fields at any nesting level
  'email',
  'attendeeEmail',
  'attendeeEmails',
  'attendeeEmails[*]',
  'allowedEmails',
  'allowedEmails[*]',
  'userEmail',
  // Transcript and note content (PII per threat model)
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

function buildLoggerOptions(): LoggerOptions {
  const isDev = config.nodeEnv === 'development';

  const options: LoggerOptions = {
    level: config.logLevel,
    redact: {
      paths: redactPaths,
      censor: '[REDACTED]',
    },
    serializers: {
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
      err: pino.stdSerializers.err,
    },
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
        }
      : {}),
  };

  return options;
}

/** Root logger instance — structured JSON in production, pretty-printed in development. */
export const logger: Logger = pino(buildLoggerOptions());

/**
 * Create a child logger with request-scoped context.
 * Attach requestId and userId for per-request tracing.
 */
export function createRequestLogger(fields: {
  requestId: string;
  userId?: string;
}): Logger {
  return logger.child(fields);
}
