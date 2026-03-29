/**
 * Integration tests — audio pipeline (T-032).
 *
 * Tests multipart audio upload → GCS storage → Pub/Sub publish,
 * async processing worker, speaker stats, signed URL generation,
 * and transcript retrieval through the Fastify app with mocked services.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { registerRoutes } from '../../src/routes/index.js';
import type { AppDependencies } from '../../src/app.js';
import type { Meeting, TranscriptSegment, Speaker } from '../../src/types/domain.js';
import { processAudio, type AudioProcessorDeps, type ProcessAudioMessage } from '../../src/services/audio-processor.js';
import type { TranscriptionResult } from '../../src/types/adapters.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const NOW = new Date('2025-06-15T10:00:00Z');

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'meeting-1',
    userId: 'user-1',
    title: 'Team Standup',
    status: 'ready',
    attendees: [{ name: 'Alice' }],
    tags: [],
    isStarred: false,
    latestNoteVersion: 0,
    searchTokens: ['team', 'standup'],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: 'seg-1',
    speaker: 'Speaker 1',
    speakerId: 'spk-1',
    text: 'Hello everyone.',
    startTime: 0,
    endTime: 5,
    confidence: 0.95,
    channel: 'system_audio',
    isUserNote: false,
    searchTokens: ['hello', 'everyone'],
    ...overrides,
  };
}

// ── Stub services ───────────────────────────────────────────────────

function stubServices() {
  return {
    meetingService: {
      create: vi.fn(),
      list: vi.fn(),
      getById: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getTranscript: vi.fn(),
      getSpeakers: vi.fn(),
      updateSpeaker: vi.fn(),
      getNotes: vi.fn(),
      getLatestNote: vi.fn(),
      getNote: vi.fn(),
      updateNote: vi.fn(),
    },
    templateService: {
      list: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      seedSystemTemplates: vi.fn(),
    },
    audioService: {
      uploadAudio: vi.fn(),
      getPlaybackUrl: vi.fn(),
      getAudioUrl: vi.fn(),
      streamAudio: vi.fn(),
      canOpenStream: vi.fn(),
      registerStream: vi.fn(),
      unregisterStream: vi.fn(),
    },
    userNotesService: { create: vi.fn(), list: vi.fn() },
    aiNotesService: { generate: vi.fn() },
    actionService: {
      create: vi.fn(),
      list: vi.fn(),
      getById: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      listByMeeting: vi.fn(),
      getSummary: vi.fn(),
    },
    searchService: { fullTextSearch: vi.fn(), semanticSearch: vi.fn() },
    aiQaService: { askQuestion: vi.fn(), meetingPrep: vi.fn() },
    calendarService: {
      connect: vi.fn(),
      callback: vi.fn(),
      listEvents: vi.fn(),
      sync: vi.fn(),
      disconnect: vi.fn(),
    },
    shareService: {
      create: vi.fn(),
      getByShareId: vi.fn(),
      listByMeeting: vi.fn(),
      revoke: vi.fn(),
    },
    userService: {
      getProfile: vi.fn(),
      updatePreferences: vi.fn(),
      deleteAccount: vi.fn(),
    },
  };
}

async function buildIntegrationApp(services: ReturnType<typeof stubServices>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorateRequest('userId', '');
  app.decorateRequest('userEmail', '');
  app.addHook('onRequest', async (request) => {
    request.userId = 'user-1';
    request.userEmail = 'user@test.com';
  });

  // Register multipart plugin (needed for audio upload routes)
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });

  await registerRoutes(app, {
    ...services,
    firestore: { healthCheck: vi.fn().mockResolvedValue(true) },
    gcs: { healthCheck: vi.fn().mockResolvedValue(true) },
    audioProcessorDeps: {} as never,
    calendarSyncWorkerDeps: {} as never,
  } as unknown as AppDependencies);

  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Audio Pipeline Integration', () => {
  let app: FastifyInstance;
  let services: ReturnType<typeof stubServices>;

  beforeEach(() => {
    services = stubServices();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ── Multipart audio upload ───────────────────────────────────────

  describe('multipart audio upload', () => {
    it('flows through to GCS storage and Pub/Sub publish via audioService', async () => {
      services.audioService.uploadAudio.mockResolvedValue({
        audioPath: 'audio/user-1/meeting-1/upload.webm',
      });

      app = await buildIntegrationApp(services);

      const boundary = '----formdata-boundary';
      const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="recording.webm"',
        'Content-Type: audio/webm',
        '',
        'fake-audio-data',
        `--${boundary}--`,
      ].join('\r\n');

      const res = await app.inject({
        method: 'POST',
        url: '/api/meetings/meeting-1/audio',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });

      expect(res.statusCode).toBe(202);
      const data = JSON.parse(res.body).data;
      expect(data.audioPath).toBe('audio/user-1/meeting-1/upload.webm');
      expect(data.status).toBe('processing');
      expect(services.audioService.uploadAudio).toHaveBeenCalledWith(
        expect.objectContaining({
          meetingId: 'meeting-1',
          userId: 'user-1',
        }),
      );
    });
  });

  // ── Async processing worker ──────────────────────────────────────

  describe('async processing worker (processAudio)', () => {
    it('downloads audio, transcribes, writes segments, and updates meeting status to ready', async () => {
      const meeting = makeMeeting({ status: 'recording', audioPath: 'audio/user-1/meeting-1/upload.webm' });

      const mockFirestore = {
        getMeeting: vi.fn().mockResolvedValue(meeting),
        updateMeeting: vi.fn().mockResolvedValue(undefined),
        batchWriteSegments: vi.fn().mockResolvedValue(undefined),
        updateSpeaker: vi.fn().mockResolvedValue(undefined),
      };

      const mockGcs = {
        download: vi.fn().mockResolvedValue(Buffer.from("fake-audio")),
        getSignedUrl: vi.fn().mockResolvedValue("https://signed-url"),
      };

      // Mock fetch for audio download
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      }) as unknown as typeof fetch;

      const transcriptionResults: TranscriptionResult[] = [
        { speaker: 'Speaker 1', speakerId: 'spk-1', text: 'Hello everyone', startTime: 0, endTime: 5, confidence: 0.95 },
        { speaker: 'Speaker 2', speakerId: 'spk-2', text: 'Good morning', startTime: 5, endTime: 10, confidence: 0.92 },
      ];

      const mockTranscription = { transcribe: vi.fn().mockResolvedValue(transcriptionResults) };
      const createTranscriptionAdapter = vi.fn().mockReturnValue(mockTranscription);

      const deps: AudioProcessorDeps = {
        firestore: mockFirestore as never,
        gcs: mockGcs as never,
        createTranscriptionAdapter,
      };

      const message: ProcessAudioMessage = {
        meetingId: 'meeting-1',
        userId: 'user-1',
        audioPath: 'audio/user-1/meeting-1/upload.webm',
      };

      await processAudio(message, deps);

      // Verify audio download
      expect(mockGcs.download).toHaveBeenCalledWith('audio/user-1/meeting-1/upload.webm');

      // Verify transcription
      expect(createTranscriptionAdapter).toHaveBeenCalledWith('deepgram');
      expect(mockTranscription.transcribe).toHaveBeenCalled();

      // Verify segments written to Firestore
      expect(mockFirestore.batchWriteSegments).toHaveBeenCalledWith(
        'meeting-1',
        expect.arrayContaining([
          expect.objectContaining({ text: 'Hello everyone', speakerId: 'spk-1' }),
          expect.objectContaining({ text: 'Good morning', speakerId: 'spk-2' }),
        ]),
      );

      // Verify meeting status updated to ready with speaker stats
      expect(mockFirestore.updateMeeting).toHaveBeenCalledWith(
        'meeting-1',
        'user-1',
        expect.objectContaining({ status: 'ready' }),
      );

      globalThis.fetch = originalFetch;
    });

    it('updates meeting status to failed on transcription error', async () => {
      const meeting = makeMeeting({ status: 'recording', audioPath: 'audio/user-1/meeting-1/upload.webm' });

      const mockFirestore = {
        getMeeting: vi.fn().mockResolvedValue(meeting),
        updateMeeting: vi.fn().mockResolvedValue(undefined),
      };

      const mockGcs = {
        download: vi.fn().mockResolvedValue(Buffer.from("fake-audio")),
        getSignedUrl: vi.fn().mockResolvedValue("https://signed-url"),
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      }) as unknown as typeof fetch;

      const mockTranscription = {
        transcribe: vi.fn().mockRejectedValue(new Error('Deepgram API timeout')),
      };

      const deps: AudioProcessorDeps = {
        firestore: mockFirestore as never,
        gcs: mockGcs as never,
        createTranscriptionAdapter: vi.fn().mockReturnValue(mockTranscription),
      };

      await expect(processAudio({
        meetingId: 'meeting-1',
        userId: 'user-1',
        audioPath: 'audio/user-1/meeting-1/upload.webm',
      }, deps)).rejects.toThrow();

      // Verify meeting marked as failed
      expect(mockFirestore.updateMeeting).toHaveBeenCalledWith(
        'meeting-1',
        'user-1',
        expect.objectContaining({ status: 'failed' }),
      );

      globalThis.fetch = originalFetch;
    });
  });

  // ── Speaker stats ────────────────────────────────────────────────

  describe('speaker stats after transcription', () => {
    it('calculates speaker stats from transcript segments', async () => {
      const meeting = makeMeeting({ status: 'recording', audioPath: 'audio/path.webm' });

      const mockFirestore = {
        getMeeting: vi.fn().mockResolvedValue(meeting),
        updateMeeting: vi.fn().mockResolvedValue(undefined),
        batchWriteSegments: vi.fn().mockResolvedValue(undefined),
        updateSpeaker: vi.fn().mockResolvedValue(undefined),
      };

      const mockGcs = {
        download: vi.fn().mockResolvedValue(Buffer.from("fake-audio")),
        getSignedUrl: vi.fn().mockResolvedValue("https://signed-url"),
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      }) as unknown as typeof fetch;

      const transcriptionResults: TranscriptionResult[] = [
        { speaker: 'Alice', speakerId: 'spk-a', text: 'Point one.', startTime: 0, endTime: 10, confidence: 0.9 },
        { speaker: 'Bob', speakerId: 'spk-b', text: 'Agreed.', startTime: 10, endTime: 15, confidence: 0.88 },
        { speaker: 'Alice', speakerId: 'spk-a', text: 'Point two.', startTime: 15, endTime: 25, confidence: 0.91 },
      ];

      const deps: AudioProcessorDeps = {
        firestore: mockFirestore as never,
        gcs: mockGcs as never,
        createTranscriptionAdapter: vi.fn().mockReturnValue({
          transcribe: vi.fn().mockResolvedValue(transcriptionResults),
        }),
      };

      await processAudio({ meetingId: 'meeting-1', userId: 'user-1', audioPath: 'audio/path.webm' }, deps);

      // The final updateMeeting call should include speakerStats
      const finalUpdate = mockFirestore.updateMeeting.mock.calls.find(
        (call: unknown[]) => (call[2] as Record<string, unknown>).status === 'ready',
      );
      expect(finalUpdate).toBeDefined();
      const updateData = finalUpdate![2] as { speakerStats: Record<string, { talkTimeSeconds: number; segmentCount: number }> };
      expect(updateData.speakerStats['spk-a'].talkTimeSeconds).toBe(20); // 10 + 10
      expect(updateData.speakerStats['spk-a'].segmentCount).toBe(2);
      expect(updateData.speakerStats['spk-b'].talkTimeSeconds).toBe(5);
      expect(updateData.speakerStats['spk-b'].segmentCount).toBe(1);

      globalThis.fetch = originalFetch;
    });
  });

  // ── Signed URL generation ────────────────────────────────────────

  describe('signed URL generation for audio playback', () => {
    it('returns signed URL with expiry via GET /api/meetings/:id/audio', async () => {
      services.audioService.getPlaybackUrl.mockResolvedValue(
        'https://storage.googleapis.com/bucket/audio/user-1/meeting-1/upload.webm?X-Goog-Signature=abc&Expires=1750000000',
      );

      app = await buildIntegrationApp(services);

      const res = await app.inject({ method: 'GET', url: '/api/meetings/meeting-1/audio' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.url).toContain('https://storage.googleapis.com');
      expect(body.data.url).toContain('Expires');
    });
  });

  // ── Transcript retrieval ─────────────────────────────────────────

  describe('transcript retrieval', () => {
    it('returns all segments ordered by time', async () => {
      const segments: TranscriptSegment[] = [
        makeSegment({ id: 'seg-1', startTime: 0, endTime: 5, text: 'Hello' }),
        makeSegment({ id: 'seg-2', startTime: 5, endTime: 12, text: 'Good morning' }),
        makeSegment({ id: 'seg-3', startTime: 12, endTime: 20, text: 'Lets begin' }),
      ];

      services.meetingService.getTranscript.mockResolvedValue({
        segments,
        hasMore: false,
      });

      app = await buildIntegrationApp(services);

      const res = await app.inject({ method: 'GET', url: '/api/meetings/meeting-1/transcript' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Transcript route returns data as array of segments directly
      expect(body.data).toHaveLength(3);
      expect(body.data[0].startTime).toBe(0);
      expect(body.data[1].startTime).toBe(5);
      expect(body.data[2].startTime).toBe(12);
    });
  });

  // ── Idempotency check ───────────────────────────────────────────

  describe('processing idempotency', () => {
    it('skips processing if meeting is already ready', async () => {
      const meeting = makeMeeting({ status: 'ready' });
      const mockFirestore = {
        getMeeting: vi.fn().mockResolvedValue(meeting),
        updateMeeting: vi.fn(),
      };

      const deps: AudioProcessorDeps = {
        firestore: mockFirestore as never,
        gcs: {} as never,
        createTranscriptionAdapter: vi.fn(),
      };

      await processAudio({ meetingId: 'meeting-1', userId: 'user-1', audioPath: 'audio/path.webm' }, deps);

      // Should not attempt to update status or process
      expect(mockFirestore.updateMeeting).not.toHaveBeenCalled();
    });
  });
});
