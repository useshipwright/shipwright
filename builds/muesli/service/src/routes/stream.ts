/**
 * WebSocket stream handler for live audio ingestion.
 *
 * WS /api/meetings/:id/stream — accepts PCM 16-bit 16kHz mono audio chunks.
 * Authenticates on upgrade. Buffers 10-second segments, writes to GCS,
 * publishes to Pub/Sub for transcription. Sends interim transcript JSON
 * frames back to client.
 *
 * Security controls:
 * - Per-user concurrent WebSocket connection limits (max 2)
 * - Maximum 4-hour connection duration
 * - Idle timeout (60s without data closes connection)
 */

import { type FastifyInstance, type FastifyPluginAsync, type FastifyRequest } from 'fastify';
import type {} from '@fastify/websocket';
import type { WebSocket } from 'ws';

import { type AudioService, AudioServiceError } from '../services/audio.js';
import { logger } from '../logger.js';

// ── Plugin options ──────────────────────────────────────────────────

export interface StreamRoutesOptions {
  audioService: AudioService;
}

// ── Route plugin ────────────────────────────────────────────────────

const streamRoutes: FastifyPluginAsync<StreamRoutesOptions> = async (
  app: FastifyInstance,
  opts: StreamRoutesOptions,
) => {
  const { audioService } = opts;

  // ── WS /api/meetings/:id/stream ──────────────────────────────────
  app.get(
    '/:id/stream',
    { websocket: true },
    async (socket: WebSocket, request: FastifyRequest<{ Params: { id: string } }>) => {
      const meetingId = request.params.id;
      const userId = request.userId;

      // Check concurrent connection limit
      if (!audioService.canOpenStream(userId)) {
        const errMsg = JSON.stringify({
          type: 'error',
          error: 'Too many concurrent streams',
        });
        socket.send(errMsg);
        socket.close(1008, 'Too many concurrent streams');
        return;
      }

      // Register connection
      audioService.registerStream(userId);

      let session;
      try {
        session = await audioService.createStreamSession(meetingId, userId);
      } catch (err) {
        audioService.unregisterStream(userId);
        const message =
          err instanceof AudioServiceError ? err.message : 'Failed to start stream';
        socket.send(JSON.stringify({ type: 'error', error: message }));
        socket.close(1011, message);
        return;
      }

      // Send session started confirmation
      socket.send(
        JSON.stringify({
          type: 'session_started',
          meetingId,
        }),
      );

      // Set up idle timeout
      const resetIdleTimer = () => {
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.idleTimer = setTimeout(() => {
          if (!session.closed) {
            logger.info({ meetingId }, 'WebSocket idle timeout');
            socket.send(
              JSON.stringify({ type: 'error', error: 'Idle timeout' }),
            );
            socket.close(1000, 'Idle timeout');
          }
        }, audioService.WS_IDLE_TIMEOUT_MS);
      };

      // Set up max duration timeout
      session.durationTimer = setTimeout(() => {
        if (!session.closed) {
          logger.info({ meetingId }, 'WebSocket max duration reached');
          socket.send(
            JSON.stringify({
              type: 'error',
              error: 'Maximum session duration reached',
            }),
          );
          socket.close(1000, 'Maximum session duration reached');
        }
      }, audioService.MAX_WS_DURATION_MS);

      resetIdleTimer();

      // Handle incoming binary audio data
      socket.on('message', async (data: Buffer | string) => {
        if (session.closed) return;

        // Only accept binary data (PCM audio)
        if (typeof data === 'string') {
          // Could be a control message
          try {
            const msg = JSON.parse(data) as { type?: string };
            if (msg.type === 'stop') {
              await audioService.finalizeStream(session);
              audioService.unregisterStream(userId);
              socket.send(
                JSON.stringify({ type: 'session_ended', meetingId }),
              );
              socket.close(1000, 'Stream stopped by client');
              return;
            }
          } catch {
            // Not valid JSON, ignore
          }
          return;
        }

        resetIdleTimer();

        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

        try {
          const result = await audioService.processChunk(session, chunk);

          if (result.flushed && result.chunkPath) {
            // Send interim transcript frame
            socket.send(
              JSON.stringify({
                type: 'segment_processed',
                chunkIndex: session.chunkIndex - 1,
                chunkPath: result.chunkPath,
              }),
            );
          }
        } catch (err) {
          logger.error({ err, meetingId }, 'Error processing audio chunk');
          socket.send(
            JSON.stringify({
              type: 'error',
              error: 'Failed to process audio chunk',
            }),
          );
        }
      });

      // Handle connection close
      socket.on('close', async () => {
        try {
          await audioService.finalizeStream(session);
        } catch (err) {
          logger.error({ err, meetingId }, 'Error finalizing stream on close');
        }
        audioService.unregisterStream(userId);
      });

      // Handle errors
      socket.on('error', (err: Error) => {
        logger.error({ err, meetingId }, 'WebSocket error');
        if (!session.closed) {
          audioService.finalizeStream(session).catch((e: unknown) => {
            logger.error({ err: e, meetingId }, 'Error finalizing stream on error');
          });
          audioService.unregisterStream(userId);
        }
      });
    },
  );
};

export default streamRoutes;
