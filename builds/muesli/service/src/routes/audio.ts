/**
 * Audio ingestion route plugin.
 *
 * POST /api/meetings/:id/audio — multipart upload (500MB limit, streaming to GCS, returns 202)
 * GET  /api/meetings/:id/audio — signed GCS URL for playback (1-hour expiry)
 *
 * MIME types validated against allowlist per threat model.
 * All responses use the standard envelope.
 */

import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {} from '@fastify/multipart';

import { AudioUploadQuerySchema, IdParamSchema, type IdParam, type AudioUploadQuery } from '../types/api.js';
import { type AudioService, AudioServiceError } from '../services/audio.js';

// ── Constants ────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

// ── Helper ──────────────────────────────────────────────────────────

function zodSchema(schema: z.ZodType): Record<string, unknown> {
  return (zodToJsonSchema as (...args: unknown[]) => Record<string, unknown>)(schema);
}

// ── Plugin options ──────────────────────────────────────────────────

export interface AudioRoutesOptions {
  audioService: AudioService;
}

// ── Route plugin ────────────────────────────────────────────────────

const audioRoutes: FastifyPluginAsync<AudioRoutesOptions> = async (
  app: FastifyInstance,
  opts: AudioRoutesOptions,
) => {
  const { audioService } = opts;

  // ── POST /api/meetings/:id/audio ─────────────────────────────────
  app.post<{ Params: IdParam; Querystring: AudioUploadQuery }>(
    '/:id/audio',
    {
      schema: {
        params: zodSchema(IdParamSchema),
        querystring: zodSchema(AudioUploadQuerySchema),
      },
    },
    async (request, reply) => {
      // Content-Length pre-check (reject early before parsing)
      const contentLength = request.headers['content-length'];
      if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
        return reply.code(413).send({
          error: { code: 413, message: `File exceeds maximum size of 500MB` },
        });
      }

      let file;
      try {
        file = await request.file({
          limits: { fileSize: MAX_FILE_SIZE },
        });
      } catch {
        return reply.code(400).send({
          error: { code: 400, message: 'Invalid multipart upload' },
        });
      }

      if (!file) {
        return reply.code(400).send({
          error: { code: 400, message: 'No file provided in multipart upload' },
        });
      }

      try {
        const result = await audioService.uploadAudio({
          meetingId: request.params.id,
          userId: request.userId,
          fileStream: file.file,
          filename: file.filename,
          mimetype: file.mimetype,
          backend: request.query.backend,
        });

        return reply.code(202).send({
          data: {
            meetingId: request.params.id,
            audioPath: result.audioPath,
            status: 'processing',
          },
        });
      } catch (err) {
        if (err instanceof AudioServiceError) {
          return reply.code(err.statusCode).send({
            error: { code: err.statusCode, message: err.message },
          });
        }
        throw err;
      }
    },
  );

  // ── GET /api/meetings/:id/audio ──────────────────────────────────
  app.get<{ Params: IdParam }>(
    '/:id/audio',
    {
      schema: {
        params: zodSchema(IdParamSchema),
      },
    },
    async (request, reply) => {
      try {
        const url = await audioService.getPlaybackUrl(
          request.params.id,
          request.userId,
        );

        return { data: { url } };
      } catch (err) {
        if (err instanceof AudioServiceError) {
          return reply.code(err.statusCode).send({
            error: { code: err.statusCode, message: err.message },
          });
        }
        throw err;
      }
    },
  );
};

export default audioRoutes;
