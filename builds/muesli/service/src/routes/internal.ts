/**
 * Internal route handlers for Pub/Sub push and Cloud Scheduler endpoints.
 *
 * POST /internal/process-audio — Pub/Sub push subscriber for async audio
 * transcription. Authenticated via OIDC token (verified by auth plugin).
 *
 * POST /internal/calendar-sync — Cloud Scheduler trigger for periodic
 * calendar sync (ADR-003). Iterates users with connected calendars.
 *
 * ADR-006: Pub/Sub push subscriptions instead of pull for audio processing.
 * Message format follows the standard Pub/Sub push envelope.
 */

import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { logger } from '../logger.js';
import { type ProcessAudioMessage, type AudioProcessorDeps, processAudio } from '../services/audio-processor.js';
import { type CalendarSyncWorkerDeps, runCalendarSync } from '../services/calendar-sync-worker.js';

// ── Pub/Sub push envelope schema ─────────────────────────────────────

const PubSubPushBodySchema = z.object({
  message: z.object({
    data: z.string(), // base64-encoded JSON
    messageId: z.string(),
  }),
  subscription: z.string(),
});

const ProcessAudioDataSchema = z.object({
  meetingId: z.string().min(1),
  userId: z.string().min(1),
  audioPath: z.string().min(1),
  backend: z.enum(['deepgram', 'whisper', 'google-stt']).optional(),
});

// ── Route options ────────────────────────────────────────────────────

export interface InternalRoutesOptions {
  audioProcessorDeps: AudioProcessorDeps;
  calendarSyncWorkerDeps?: CalendarSyncWorkerDeps;
}

// ── Plugin ───────────────────────────────────────────────────────────

const internalRoutes: FastifyPluginAsync<InternalRoutesOptions> = async (
  app: FastifyInstance,
  opts: InternalRoutesOptions,
) => {
  const { audioProcessorDeps, calendarSyncWorkerDeps } = opts;

  /**
   * POST /process-audio
   *
   * Pub/Sub push handler. Receives the standard push envelope, decodes
   * the base64 message data, and invokes the audio processing pipeline.
   *
   * Auth: OIDC token (handled by auth plugin for /internal/* prefix).
   * Returns 204 on success (ack), 200 for idempotent skip, 500 on failure
   * (Pub/Sub will retry).
   */
  app.post<{ Body: z.infer<typeof PubSubPushBodySchema> }>(
    '/process-audio',
    {
      schema: {
        body: { type: 'object' } as const,
      },
    },
    async (request, reply) => {
      const log = logger.child({ route: 'process-audio' });

      // Parse the Pub/Sub push envelope
      let parsedBody: z.infer<typeof PubSubPushBodySchema>;
      try {
        parsedBody = PubSubPushBodySchema.parse(request.body);
      } catch (err) {
        log.warn({ err }, 'Invalid Pub/Sub push envelope');
        return reply.code(400).send({
          error: { code: 400, message: 'Invalid Pub/Sub push envelope' },
        });
      }

      // Decode the base64 message data
      let messageData: ProcessAudioMessage;
      try {
        const decoded = Buffer.from(parsedBody.message.data, 'base64').toString('utf-8');
        const parsed = JSON.parse(decoded) as unknown;
        messageData = ProcessAudioDataSchema.parse(parsed);
      } catch (err) {
        log.warn({ err, messageId: parsedBody.message.messageId }, 'Invalid message data');
        // Return 204 to ack the malformed message — retrying won't help
        return reply.code(204).send();
      }

      log.info(
        { meetingId: messageData.meetingId, messageId: parsedBody.message.messageId },
        'Processing audio from Pub/Sub push',
      );

      try {
        await processAudio(messageData, audioProcessorDeps);
        return reply.code(204).send();
      } catch (err) {
        log.error(
          { err, meetingId: messageData.meetingId },
          'Audio processing failed — Pub/Sub will retry',
        );
        return reply.code(500).send({
          error: { code: 500, message: 'Audio processing failed' },
        });
      }
    },
  );
  /**
   * POST /calendar-sync
   *
   * Cloud Scheduler trigger for periodic calendar sync (ADR-003).
   * Iterates all users with calendarConnected=true and performs
   * incremental sync per user.
   *
   * Auth: OIDC token (handled by auth plugin for /internal/* prefix).
   * Returns 204 on success, 500 on fatal failure.
   */
  app.post('/calendar-sync', async (_request, reply) => {
    const log = logger.child({ route: 'calendar-sync' });

    if (!calendarSyncWorkerDeps) {
      log.warn('Calendar sync worker dependencies not configured');
      return reply.code(204).send();
    }

    try {
      const result = await runCalendarSync(calendarSyncWorkerDeps);

      log.info(result, 'Calendar sync completed');

      // Always return 204 to acknowledge the Cloud Scheduler trigger.
      // Individual user failures are logged but don't fail the batch.
      return reply.code(204).send();
    } catch (err) {
      log.error({ err }, 'Calendar sync batch failed');
      return reply.code(500).send({
        error: { code: 500, message: 'Calendar sync failed' },
      });
    }
  });
};

export default internalRoutes;
