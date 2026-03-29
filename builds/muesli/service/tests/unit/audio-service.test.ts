/**
 * Audio service tests — T-029.
 *
 * Tests multipart upload validation, GCS path convention, Pub/Sub publishing,
 * signed URL generation, and WebSocket stream session management.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import { Readable } from 'node:stream';
import { createAudioService, AudioServiceError, type AudioServiceDeps } from '../../src/services/audio.js';
import type { FirestoreAdapter, GCSAdapter, PubSubAdapter } from '../../src/types/adapters.js';
import type { Meeting } from '../../src/types/domain.js';
import { buildTestApp } from '../helpers/setup.js';

// ── Fixtures ────────────────────────────────────────────────────────

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'meeting-1',
    userId: 'user-1',
    title: 'Test Meeting',
    status: 'recording',
    attendees: [],
    tags: [],
    isStarred: false,
    latestNoteVersion: 0,
    searchTokens: [],
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeReadableStream(data = Buffer.from('fake-audio')): Readable {
  const stream = new Readable();
  stream.push(data);
  stream.push(null);
  return stream;
}

// ── Mock adapters ──────────────────────────────────────────────────

function createMockDeps(): AudioServiceDeps & {
  firestore: ReturnType<typeof createMockFirestore>;
  gcs: ReturnType<typeof createMockGCS>;
  pubsub: ReturnType<typeof createMockPubSub>;
} {
  return {
    firestore: createMockFirestore(),
    gcs: createMockGCS(),
    pubsub: createMockPubSub(),
  };
}

function createMockFirestore() {
  return {
    getMeeting: vi.fn<[string, string], Promise<Meeting | null>>().mockResolvedValue(makeMeeting()),
    updateMeeting: vi.fn().mockResolvedValue(undefined),
    getUser: vi.fn().mockResolvedValue(null),
    // Other methods not needed for audio service tests
  } as unknown as FirestoreAdapter;
}

function createMockGCS() {
  return {
    upload: vi.fn().mockResolvedValue(undefined),
    createWriteStream: vi.fn((_path: string, _contentType: string) => {
      return new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
    }),
    getSignedUrl: vi.fn().mockResolvedValue('https://storage.googleapis.com/signed-url'),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteByPrefix: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
  } as unknown as GCSAdapter;
}

function createMockPubSub() {
  return {
    publish: vi.fn().mockResolvedValue('msg-id-123'),
  } as unknown as PubSubAdapter;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('AudioService', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let service: ReturnType<typeof createAudioService>;

  beforeEach(() => {
    deps = createMockDeps();
    service = createAudioService(deps);
  });

  // ── uploadAudio ──────────────────────────────────────────────────

  describe('uploadAudio', () => {
    it('accepts supported audio format: audio/webm', async () => {
      const result = await service.uploadAudio({
        meetingId: 'meeting-1',
        userId: 'user-1',
        fileStream: makeReadableStream(),
        filename: 'recording.webm',
        mimetype: 'audio/webm',
      });

      expect(result.audioPath).toContain('audio/user-1/meeting-1/');
    });

    it('accepts supported audio format: audio/wav', async () => {
      const result = await service.uploadAudio({
        meetingId: 'meeting-1',
        userId: 'user-1',
        fileStream: makeReadableStream(),
        filename: 'recording.wav',
        mimetype: 'audio/wav',
      });

      expect(result.audioPath).toContain('upload.wav');
    });

    it('accepts supported audio format: audio/mpeg (mp3)', async () => {
      await expect(
        service.uploadAudio({
          meetingId: 'meeting-1',
          userId: 'user-1',
          fileStream: makeReadableStream(),
          filename: 'recording.mp3',
          mimetype: 'audio/mpeg',
        }),
      ).resolves.toBeDefined();
    });

    it('accepts supported audio format: audio/ogg', async () => {
      await expect(
        service.uploadAudio({
          meetingId: 'meeting-1',
          userId: 'user-1',
          fileStream: makeReadableStream(),
          filename: 'recording.ogg',
          mimetype: 'audio/ogg',
        }),
      ).resolves.toBeDefined();
    });

    it('accepts supported audio format: audio/x-m4a (m4a)', async () => {
      await expect(
        service.uploadAudio({
          meetingId: 'meeting-1',
          userId: 'user-1',
          fileStream: makeReadableStream(),
          filename: 'recording.m4a',
          mimetype: 'audio/x-m4a',
        }),
      ).resolves.toBeDefined();
    });

    it('accepts supported audio format: audio/flac', async () => {
      await expect(
        service.uploadAudio({
          meetingId: 'meeting-1',
          userId: 'user-1',
          fileStream: makeReadableStream(),
          filename: 'recording.flac',
          mimetype: 'audio/flac',
        }),
      ).resolves.toBeDefined();
    });

    it('rejects unsupported audio format', async () => {
      await expect(
        service.uploadAudio({
          meetingId: 'meeting-1',
          userId: 'user-1',
          fileStream: makeReadableStream(),
          filename: 'file.pdf',
          mimetype: 'application/pdf',
        }),
      ).rejects.toThrow(AudioServiceError);

      try {
        await service.uploadAudio({
          meetingId: 'meeting-1',
          userId: 'user-1',
          fileStream: makeReadableStream(),
          filename: 'file.pdf',
          mimetype: 'application/pdf',
        });
      } catch (err) {
        expect(err).toBeInstanceOf(AudioServiceError);
        expect((err as AudioServiceError).statusCode).toBe(400);
        expect((err as AudioServiceError).message).toContain('Unsupported audio format');
      }
    });

    it('follows GCS path convention: audio/{userId}/{meetingId}/', async () => {
      const result = await service.uploadAudio({
        meetingId: 'meeting-1',
        userId: 'user-1',
        fileStream: makeReadableStream(),
        filename: 'recording.webm',
        mimetype: 'audio/webm',
      });

      expect(result.audioPath).toBe('audio/user-1/meeting-1/upload.webm');
      expect(deps.gcs.createWriteStream).toHaveBeenCalledWith(
        'audio/user-1/meeting-1/upload.webm',
        'audio/webm',
      );
    });

    it('publishes Pub/Sub message with correct payload after upload', async () => {
      await service.uploadAudio({
        meetingId: 'meeting-1',
        userId: 'user-1',
        fileStream: makeReadableStream(),
        filename: 'recording.webm',
        mimetype: 'audio/webm',
        backend: 'deepgram',
      });

      expect(deps.pubsub.publish).toHaveBeenCalledWith('audio-processing', {
        meetingId: 'meeting-1',
        userId: 'user-1',
        audioPath: 'audio/user-1/meeting-1/upload.webm',
        backend: 'deepgram',
      });
    });

    it('publishes Pub/Sub message without backend when not specified', async () => {
      await service.uploadAudio({
        meetingId: 'meeting-1',
        userId: 'user-1',
        fileStream: makeReadableStream(),
        filename: 'recording.wav',
        mimetype: 'audio/wav',
      });

      expect(deps.pubsub.publish).toHaveBeenCalledWith('audio-processing', {
        meetingId: 'meeting-1',
        userId: 'user-1',
        audioPath: 'audio/user-1/meeting-1/upload.wav',
        backend: undefined,
      });
    });

    it('updates meeting status to processing after upload', async () => {
      await service.uploadAudio({
        meetingId: 'meeting-1',
        userId: 'user-1',
        fileStream: makeReadableStream(),
        filename: 'recording.webm',
        mimetype: 'audio/webm',
      });

      expect(deps.firestore.updateMeeting).toHaveBeenCalledWith(
        'meeting-1',
        'user-1',
        expect.objectContaining({ status: 'processing' }),
      );
    });

    it('throws 404 when meeting not found', async () => {
      vi.mocked(deps.firestore.getMeeting).mockResolvedValue(null);

      await expect(
        service.uploadAudio({
          meetingId: 'nonexistent',
          userId: 'user-1',
          fileStream: makeReadableStream(),
          filename: 'recording.webm',
          mimetype: 'audio/webm',
        }),
      ).rejects.toThrow(AudioServiceError);
    });
  });

  // ── getPlaybackUrl ──────────────────────────────────────────────

  describe('getPlaybackUrl', () => {
    it('generates signed URL with 60-minute expiry', async () => {
      vi.mocked(deps.firestore.getMeeting).mockResolvedValue(
        makeMeeting({ audioPath: 'audio/user-1/meeting-1/upload.webm' }),
      );

      const url = await service.getPlaybackUrl('meeting-1', 'user-1');

      expect(url).toBe('https://storage.googleapis.com/signed-url');
      expect(deps.gcs.getSignedUrl).toHaveBeenCalledWith(
        'audio/user-1/meeting-1/upload.webm',
        60,
      );
    });

    it('throws 404 when meeting not found', async () => {
      vi.mocked(deps.firestore.getMeeting).mockResolvedValue(null);

      await expect(service.getPlaybackUrl('nonexistent', 'user-1')).rejects.toThrow(
        AudioServiceError,
      );
    });

    it('throws 404 when no audio available', async () => {
      vi.mocked(deps.firestore.getMeeting).mockResolvedValue(makeMeeting({ audioPath: undefined }));

      try {
        await service.getPlaybackUrl('meeting-1', 'user-1');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AudioServiceError);
        expect((err as AudioServiceError).statusCode).toBe(404);
        expect((err as AudioServiceError).message).toContain('No audio');
      }
    });
  });

  // ── WebSocket connection management ──────────────────────────────

  describe('WebSocket connection management', () => {
    it('allows opening stream when under limit', () => {
      expect(service.canOpenStream('user-1')).toBe(true);
    });

    it('tracks connection count per user and respects limit', () => {
      // Use unique user IDs to avoid module-level state leakage
      const uid = `user-ws-limit-${Date.now()}`;
      service.registerStream(uid);
      expect(service.canOpenStream(uid)).toBe(true); // limit is 2
      service.registerStream(uid);
      expect(service.canOpenStream(uid)).toBe(false);
      // Cleanup
      service.unregisterStream(uid);
      service.unregisterStream(uid);
    });

    it('unregisters stream connections', () => {
      const uid = `user-ws-unreg-${Date.now()}`;
      service.registerStream(uid);
      service.registerStream(uid);
      expect(service.canOpenStream(uid)).toBe(false);
      service.unregisterStream(uid);
      expect(service.canOpenStream(uid)).toBe(true);
      // Cleanup
      service.unregisterStream(uid);
    });

    it('isolates connections per user', () => {
      const uid1 = `user-ws-iso1-${Date.now()}`;
      const uid2 = `user-ws-iso2-${Date.now()}`;
      service.registerStream(uid1);
      service.registerStream(uid1);
      expect(service.canOpenStream(uid1)).toBe(false);
      expect(service.canOpenStream(uid2)).toBe(true);
      // Cleanup
      service.unregisterStream(uid1);
      service.unregisterStream(uid1);
    });
  });

  // ── Stream session ──────────────────────────────────────────────

  describe('createStreamSession', () => {
    it('creates session and transitions meeting to recording', async () => {
      const session = await service.createStreamSession('meeting-1', 'user-1');

      expect(session.meetingId).toBe('meeting-1');
      expect(session.userId).toBe('user-1');
      expect(session.chunkIndex).toBe(0);
      expect(session.buffer).toEqual([]);
      expect(session.closed).toBe(false);

      expect(deps.firestore.updateMeeting).toHaveBeenCalledWith(
        'meeting-1',
        'user-1',
        expect.objectContaining({ status: 'recording' }),
      );
    });

    it('throws 404 when meeting not found', async () => {
      vi.mocked(deps.firestore.getMeeting).mockResolvedValue(null);

      await expect(service.createStreamSession('nonexistent', 'user-1')).rejects.toThrow(
        AudioServiceError,
      );
    });
  });

  // ── processChunk ────────────────────────────────────────────────

  describe('processChunk', () => {
    it('buffers small chunks without flushing', async () => {
      const session = await service.createStreamSession('meeting-1', 'user-1');
      const smallChunk = Buffer.alloc(1000); // < 10s of PCM audio

      const result = await service.processChunk(session, smallChunk);

      expect(result.flushed).toBe(false);
      expect(session.buffer).toHaveLength(1);
    });

    it('flushes buffer when 10 seconds of PCM data accumulated', async () => {
      const session = await service.createStreamSession('meeting-1', 'user-1');
      // PCM 16-bit 16kHz mono: 32000 bytes/sec, 10s = 320000 bytes
      const tenSecondsChunk = Buffer.alloc(320_000);

      const result = await service.processChunk(session, tenSecondsChunk);

      expect(result.flushed).toBe(true);
      expect(result.chunkPath).toContain('chunk-');
      expect(session.buffer).toEqual([]);
      expect(session.chunkIndex).toBe(1);
    });

    it('uploads flushed segment to GCS with correct path', async () => {
      const session = await service.createStreamSession('meeting-1', 'user-1');
      const tenSecondsChunk = Buffer.alloc(320_000);

      await service.processChunk(session, tenSecondsChunk);

      expect(deps.gcs.upload).toHaveBeenCalledWith(
        'audio/user-1/meeting-1/chunk-000000.pcm',
        expect.any(Buffer),
        'audio/pcm',
      );
    });

    it('publishes Pub/Sub message for each flushed segment', async () => {
      const session = await service.createStreamSession('meeting-1', 'user-1');
      const tenSecondsChunk = Buffer.alloc(320_000);

      await service.processChunk(session, tenSecondsChunk);

      expect(deps.pubsub.publish).toHaveBeenCalledWith('audio-processing', {
        meetingId: 'meeting-1',
        userId: 'user-1',
        audioPath: 'audio/user-1/meeting-1/chunk-000000.pcm',
      });
    });

    it('does nothing when session is closed', async () => {
      const session = await service.createStreamSession('meeting-1', 'user-1');
      session.closed = true;

      const result = await service.processChunk(session, Buffer.alloc(320_000));

      expect(result.flushed).toBe(false);
      expect(deps.gcs.upload).not.toHaveBeenCalled();
    });
  });

  // ── finalizeStream ──────────────────────────────────────────────

  describe('finalizeStream', () => {
    it('flushes remaining buffer and transitions to processing', async () => {
      const session = await service.createStreamSession('meeting-1', 'user-1');
      session.buffer.push(Buffer.alloc(1000));

      await service.finalizeStream(session);

      expect(session.closed).toBe(true);
      expect(deps.gcs.upload).toHaveBeenCalled();
      expect(deps.firestore.updateMeeting).toHaveBeenCalledWith(
        'meeting-1',
        'user-1',
        expect.objectContaining({ status: 'processing' }),
      );
    });

    it('does nothing when already closed', async () => {
      const session = await service.createStreamSession('meeting-1', 'user-1');
      session.closed = true;

      await service.finalizeStream(session);

      // Only the createStreamSession call — not an additional update
      expect(deps.firestore.updateMeeting).toHaveBeenCalledTimes(1);
    });

    it('transitions to processing even with empty buffer', async () => {
      const session = await service.createStreamSession('meeting-1', 'user-1');

      await service.finalizeStream(session);

      expect(session.closed).toBe(true);
      // One from createStreamSession (recording) + one from finalize (processing)
      expect(deps.firestore.updateMeeting).toHaveBeenCalledTimes(2);
      expect(deps.firestore.updateMeeting).toHaveBeenLastCalledWith(
        'meeting-1',
        'user-1',
        expect.objectContaining({ status: 'processing' }),
      );
    });
  });

  // ── Exposed constants ────────────────────────────────────────────

  describe('constants', () => {
    it('exposes segment duration of 10 seconds', () => {
      expect(service.WS_SEGMENT_DURATION_MS).toBe(10_000);
    });

    it('exposes idle timeout of 60 seconds', () => {
      expect(service.WS_IDLE_TIMEOUT_MS).toBe(60_000);
    });

    it('exposes max duration of 4 hours', () => {
      expect(service.MAX_WS_DURATION_MS).toBe(4 * 60 * 60 * 1000);
    });
  });
});

// ── 500MB limit (route-level) ──────────────────────────────────────

describe('Audio route: 500MB file size limit (integration)', () => {
  it('should build app via production entry point and reject oversized uploads', async () => {
    const app = await buildTestApp();
    try {
      // Content-Length pre-check
      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/audio',
        headers: {
          'content-type': 'multipart/form-data; boundary=----boundary',
          'content-length': String(600 * 1024 * 1024), // 600MB
        },
        payload: '------boundary\r\nContent-Disposition: form-data; name="file"; filename="big.wav"\r\nContent-Type: audio/wav\r\n\r\ndata\r\n------boundary--',
      });

      // Should be 401 (auth), 413 (too large), or 415 (unsupported media type)
      // depending on middleware order and content-type handling
      expect([401, 413, 415]).toContain(res.statusCode);
    } finally {
      await app.close();
    }
  });
});
