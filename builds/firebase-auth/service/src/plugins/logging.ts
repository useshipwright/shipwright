/**
 * Logging plugin — ADR-005.
 *
 * Configures Pino for structured JSON output compatible with Cloud Logging
 * using @google-cloud/pino-logging-gcp-config for severity mapping
 * (info→INFO, error→ERROR), message key ('message' not 'msg'), and
 * GCP timestamp format. Applies redaction serializers from lib/redact.ts
 * for email, UID, token, and credential scrubbing. Injects correlationId
 * into child logger per request via onRequest hook.
 *
 * Mitigates: Credential Exposure in Logs (threat model).
 */

import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { LoggerOptions } from 'pino';
import { stdSerializers } from 'pino';
import { createGcpLoggingPinoConfig } from '@google-cloud/pino-logging-gcp-config';
import { redactSensitive, redactString } from '../lib/redact.js';
import { config } from '../config.js';

// Pino Logger instances have a `serializers` property at runtime,
// but it's not exposed in @types/pino. This interface provides type-safe access.
interface PinoWithSerializers {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serializers: Record<string, (...args: any[]) => any>;
}

/**
 * Custom err serializer that chains Pino's default error serializer with
 * redaction to prevent credential leakage in uncaught exception stack traces.
 *
 * Threat model: "Credential Exposure in Logs" — Pino redaction serializers
 * must strip JWT patterns, SA JSON patterns, and bearer tokens from err
 * serializer output (message + stack).
 */
export const redactingErrSerializer = stdSerializers.wrapErrorSerializer(
  (serializedErr) => {
    if (serializedErr.message) {
      serializedErr.message = redactString(serializedErr.message);
    }
    if (serializedErr.stack) {
      serializedErr.stack = redactString(serializedErr.stack);
    }
    return serializedErr;
  },
);

/**
 * Creates Pino LoggerOptions configured for GCP Cloud Logging.
 *
 * Uses @google-cloud/pino-logging-gcp-config for:
 *   - Severity mapping: pino levels → GCP severity (info→INFO, error→ERROR)
 *   - Message key: 'message' instead of 'msg'
 *   - GCP timestamp format: seconds + nanos
 *   - Sequential insertId for log ordering
 *
 * Applies custom serializers for err redaction and formatters.log for
 * deep scrubbing of sensitive patterns (JWT, PEM keys, SA JSON, bearer tokens)
 * from all structured log data.
 *
 * Designed to be passed to Fastify at construction time:
 *   Fastify({ logger: createLoggerConfig() })
 */
export function createLoggerConfig(): LoggerOptions {
  return createGcpLoggingPinoConfig(
    {
      serviceContext: { service: 'firebase-auth' },
      // NOTE: "inihibitDiagnosticMessage" is the library's own misspelling (v1.3.1)
      inihibitDiagnosticMessage: true,
    },
    {
      level: config.logLevel,
      serializers: {
        err: redactingErrSerializer,
      },
      formatters: {
        log: (obj) => redactSensitive(obj) as Record<string, unknown>,
      },
    },
  );
}

/**
 * Fastify plugin that injects correlationId into per-request child logger
 * and applies the redacting err serializer to all logger instances.
 * Emits structured request lifecycle log on every response.
 */
async function logging(app: FastifyInstance): Promise<void> {
  // Override the default err serializer with our redacting version
  const appLogger = app.log as unknown as PinoWithSerializers;
  appLogger.serializers = {
    ...stdSerializers,
    ...appLogger.serializers,
    err: redactingErrSerializer,
  };

  // Inject correlationId into every log entry via child bindings
  app.addHook('onRequest', async (request) => {
    request.log = app.log.child({ correlationId: request.correlationId });
    // Re-apply the serializer on the child logger
    const reqLogger = request.log as unknown as PinoWithSerializers;
    reqLogger.serializers = {
      ...reqLogger.serializers,
      err: redactingErrSerializer,
    };
  });

  // Emit structured request lifecycle log for every completed request
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
        correlationId: request.correlationId,
      },
      'request completed',
    );
  });
}

export default fp(logging, {
  name: 'logging',
  dependencies: ['correlation-id'],
});
