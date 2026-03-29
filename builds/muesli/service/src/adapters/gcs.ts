/**
 * GCS adapter implementation (ADR-005).
 *
 * Wraps @google-cloud/storage. Handles audio file uploads to audio/{userId}/{meetingId}/
 * path structure, generates signed download URLs with 1-hour expiry via signBlob,
 * deletes audio on meeting deletion, and supports streaming writes for WebSocket chunks.
 *
 * Signed URLs are never logged per threat model requirements (signed GCS URL leakage).
 */

import { Storage, type Bucket, type File } from '@google-cloud/storage';

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { GCSAdapter } from '../types/adapters.js';

export type { GCSAdapter } from '../types/adapters.js';

const DEFAULT_EXPIRATION_MINUTES = 60;

export function createGCSAdapter(): GCSAdapter {
  const storage = new Storage({
    projectId: config.googleCloudProject || undefined,
  });
  // Use a placeholder bucket name when GCS_BUCKET is not set so the server
  // can still start (requests will fail at call time with clear GCS errors).
  const bucket: Bucket = storage.bucket(config.gcsBucket || 'unconfigured-bucket');

  return {
    async upload(path: string, data: Buffer, contentType: string): Promise<void> {
      const file: File = bucket.file(path);
      await file.save(data, {
        contentType,
        resumable: false,
      });
      logger.info({ path }, 'File uploaded to GCS');
    },

    createWriteStream(path: string, contentType: string): NodeJS.WritableStream {
      const file: File = bucket.file(path);
      const stream = file.createWriteStream({
        contentType,
        resumable: false,
      });
      stream.on('error', (err) => {
        logger.error({ err, path }, 'GCS write stream error');
      });
      stream.on('finish', () => {
        logger.info({ path }, 'GCS write stream finished');
      });
      return stream;
    },

    async getSignedUrl(path: string, expirationMinutes?: number): Promise<string> {
      const file: File = bucket.file(path);
      const expires = Date.now() + (expirationMinutes ?? DEFAULT_EXPIRATION_MINUTES) * 60 * 1000;
      const [url] = await file.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires,
      });
      // Signed URLs must never be logged (threat model: signed GCS URL leakage)
      logger.info({ path }, 'Signed URL generated');
      return url;
    },

    async download(path: string): Promise<Buffer> {
      const file: File = bucket.file(path);
      const [contents] = await file.download();
      logger.info({ path, bytes: contents.length }, 'File downloaded from GCS');
      return contents;
    },

    async delete(path: string): Promise<void> {
      const file: File = bucket.file(path);
      await file.delete({ ignoreNotFound: true });
      logger.info({ path }, 'File deleted from GCS');
    },

    async deleteByPrefix(prefix: string): Promise<void> {
      await bucket.deleteFiles({ prefix, force: true });
      logger.info({ prefix }, 'Files deleted by prefix from GCS');
    },

    async healthCheck(): Promise<boolean> {
      try {
        await bucket.exists();
        return true;
      } catch {
        return false;
      }
    },
  };
}
