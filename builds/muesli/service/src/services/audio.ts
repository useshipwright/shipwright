/**
 * Audio service — business logic for audio ingestion, streaming, and playback.
 *
 * Handles multipart upload streaming to GCS, Pub/Sub message publishing for
 * async transcription, signed URL generation for playback, and WebSocket
 * stream session management with per-user connection limits.
 *
 * All operations are scoped by userId for tenant isolation (IDOR prevention).
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { FirestoreAdapter, GCSAdapter, PubSubAdapter } from '../types/adapters.js';
import type { TranscriptionBackend } from '../types/domain.js';
import { logger } from '../logger.js';

// ── Constants ────────────────────────────────────────────────────────

const AUDIO_PROCESSING_TOPIC = 'audio-processing';
const SIGNED_URL_EXPIRY_MINUTES = 60;
const MAX_CONCURRENT_WS_PER_USER = 2;
const MAX_WS_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours
const WS_SEGMENT_DURATION_MS = 10_000; // 10 seconds
const WS_IDLE_TIMEOUT_MS = 60_000; // 60 seconds

const ALLOWED_MIME_TYPES = new Set([
  'audio/webm',
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/x-m4a',
  'audio/mp4',
  'audio/flac',
  'audio/x-flac',
  'application/octet-stream',
]);

// ── Service interface ────────────────────────────────────────────────

export interface AudioServiceDeps {
  firestore: FirestoreAdapter;
  gcs: GCSAdapter;
  pubsub: PubSubAdapter;
}

export interface UploadAudioParams {
  meetingId: string;
  userId: string;
  fileStream: Readable;
  filename: string;
  mimetype: string;
  backend?: TranscriptionBackend;
}

export interface StreamSession {
  meetingId: string;
  userId: string;
  chunkIndex: number;
  buffer: Buffer[];
  bufferDuration: number;
  startedAt: number;
  lastDataAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  durationTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

// ── Active connection tracking ──────────────────────────────────────

const activeConnections = new Map<string, number>();

// ── Service factory ─────────────────────────────────────────────────

export function createAudioService(deps: AudioServiceDeps) {
  const { firestore, gcs, pubsub } = deps;

  return {
    /**
     * Stream an uploaded audio file to GCS and publish a processing message.
     * Returns 202 — processing is async.
     */
    async uploadAudio(params: UploadAudioParams): Promise<{ audioPath: string }> {
      const { meetingId, userId, fileStream, filename, mimetype, backend } = params;

      // Verify meeting ownership
      const meeting = await firestore.getMeeting(meetingId, userId);
      if (!meeting) {
        throw new AudioServiceError(404, 'Meeting not found');
      }

      // Validate MIME type
      if (!ALLOWED_MIME_TYPES.has(mimetype)) {
        throw new AudioServiceError(400, `Unsupported audio format: ${mimetype}. Supported: webm, wav, mp3, ogg, m4a, flac`);
      }

      // Build GCS path: audio/{userId}/{meetingId}/{filename}
      const ext = filename.split('.').pop() ?? 'bin';
      const audioPath = `audio/${userId}/${meetingId}/upload.${ext}`;

      // Stream to GCS without buffering entire file in memory
      const writeStream = gcs.createWriteStream(audioPath, mimetype);
      await pipeline(fileStream, writeStream);

      // Update meeting status and audio path
      await firestore.updateMeeting(meetingId, userId, {
        status: 'processing',
        audioPath,
        updatedAt: new Date(),
      });

      // Publish to Pub/Sub for async transcription
      await pubsub.publish(AUDIO_PROCESSING_TOPIC, {
        meetingId,
        userId,
        audioPath,
        backend,
      });

      logger.info({ meetingId, audioPath }, 'Audio uploaded and processing queued');
      return { audioPath };
    },

    /**
     * Get a signed download URL for audio playback.
     * Scoped to meeting owner per threat model.
     */
    async getPlaybackUrl(meetingId: string, userId: string): Promise<string> {
      const meeting = await firestore.getMeeting(meetingId, userId);
      if (!meeting) {
        throw new AudioServiceError(404, 'Meeting not found');
      }
      if (!meeting.audioPath) {
        throw new AudioServiceError(404, 'No audio available for this meeting');
      }

      // Generate signed URL — never logged (threat model: signed GCS URL leakage)
      return gcs.getSignedUrl(meeting.audioPath, SIGNED_URL_EXPIRY_MINUTES);
    },

    /**
     * Check if a user can open a new WebSocket stream connection.
     */
    canOpenStream(userId: string): boolean {
      const count = activeConnections.get(userId) ?? 0;
      return count < MAX_CONCURRENT_WS_PER_USER;
    },

    /**
     * Register a new WebSocket stream connection.
     */
    registerStream(userId: string): void {
      const count = activeConnections.get(userId) ?? 0;
      activeConnections.set(userId, count + 1);
    },

    /**
     * Unregister a WebSocket stream connection.
     */
    unregisterStream(userId: string): void {
      const count = activeConnections.get(userId) ?? 0;
      const next = Math.max(0, count - 1);
      if (next === 0) {
        activeConnections.delete(userId);
      } else {
        activeConnections.set(userId, next);
      }
    },

    /**
     * Create a new streaming session for a WebSocket connection.
     */
    async createStreamSession(
      meetingId: string,
      userId: string,
    ): Promise<StreamSession> {
      const meeting = await firestore.getMeeting(meetingId, userId);
      if (!meeting) {
        throw new AudioServiceError(404, 'Meeting not found');
      }

      // Transition to recording
      await firestore.updateMeeting(meetingId, userId, {
        status: 'recording',
        startedAt: new Date(),
        updatedAt: new Date(),
      });

      const now = Date.now();
      return {
        meetingId,
        userId,
        chunkIndex: 0,
        buffer: [],
        bufferDuration: 0,
        startedAt: now,
        lastDataAt: now,
        idleTimer: null,
        durationTimer: null,
        closed: false,
      };
    },

    /**
     * Process an incoming PCM audio chunk from WebSocket.
     * Buffers data and flushes to GCS every 10 seconds.
     * PCM 16-bit 16kHz mono = 32000 bytes/second.
     */
    async processChunk(
      session: StreamSession,
      chunk: Buffer,
    ): Promise<{ flushed: boolean; chunkPath?: string }> {
      if (session.closed) return { flushed: false };

      session.buffer.push(chunk);
      session.lastDataAt = Date.now();

      // PCM 16-bit 16kHz mono: 2 bytes * 16000 samples = 32000 bytes/sec
      const bytesPerSecond = 32000;
      const totalBytes = session.buffer.reduce((sum, b) => sum + b.length, 0);
      session.bufferDuration = (totalBytes / bytesPerSecond) * 1000;

      if (session.bufferDuration >= WS_SEGMENT_DURATION_MS) {
        return this.flushSegment(session);
      }

      return { flushed: false };
    },

    /**
     * Flush buffered audio to GCS and publish for processing.
     */
    async flushSegment(
      session: StreamSession,
    ): Promise<{ flushed: boolean; chunkPath: string }> {
      const { meetingId, userId } = session;
      const data = Buffer.concat(session.buffer as Uint8Array[]);
      session.buffer = [];
      session.bufferDuration = 0;

      const chunkPath = `audio/${userId}/${meetingId}/chunk-${String(session.chunkIndex).padStart(6, '0')}.pcm`;
      session.chunkIndex++;

      await gcs.upload(chunkPath, data, 'audio/pcm');

      // Publish segment for transcription
      await pubsub.publish(AUDIO_PROCESSING_TOPIC, {
        meetingId,
        userId,
        audioPath: chunkPath,
      });

      logger.info({ meetingId, chunkPath }, 'Stream segment flushed');
      return { flushed: true, chunkPath };
    },

    /**
     * Finalize a streaming session — flush remaining buffer and transition meeting.
     */
    async finalizeStream(session: StreamSession): Promise<void> {
      if (session.closed) return;
      session.closed = true;

      if (session.idleTimer) clearTimeout(session.idleTimer);
      if (session.durationTimer) clearTimeout(session.durationTimer);

      // Flush remaining buffer if any
      if (session.buffer.length > 0) {
        await this.flushSegment(session);
      }

      // Transition to processing
      await firestore.updateMeeting(session.meetingId, session.userId, {
        status: 'processing',
        endedAt: new Date(),
        updatedAt: new Date(),
      });

      logger.info(
        { meetingId: session.meetingId, chunks: session.chunkIndex },
        'Stream finalized',
      );
    },

    /** Max WebSocket session duration in ms. */
    MAX_WS_DURATION_MS,
    /** Idle timeout in ms. */
    WS_IDLE_TIMEOUT_MS,
    /** Segment duration in ms. */
    WS_SEGMENT_DURATION_MS,
  };
}

// ── Error class ──────────────────────────────────────────────────────

export class AudioServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AudioServiceError';
  }
}

export type AudioService = ReturnType<typeof createAudioService>;
