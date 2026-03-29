/**
 * Google Speech-to-Text adapter tests — T-029.
 *
 * Tests GoogleSttTranscriptionAdapter: Chirp model configuration,
 * response mapping to TranscriptSegment, diarization, duration parsing,
 * and retry logic on gRPC transient errors.
 *
 * Strategy: Mock @google-cloud/speech via vi.mock.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @google-cloud/speech ──────────────────────────────────────

const mockRecognize = vi.fn();

vi.mock('@google-cloud/speech', () => {
  class MockSpeechClient {
    recognize = mockRecognize;
  }
  return {
    v2: {
      SpeechClient: MockSpeechClient,
    },
  };
});

import { GoogleSttTranscriptionAdapter } from '../../src/adapters/transcription/google-stt.js';
import type { TranscribeOptions } from '../../src/types/adapters.js';

// ── Fixtures ────────────────────────────────────────────────────────

const defaultOptions: TranscribeOptions = {
  backend: 'google-stt',
  enableDiarization: true,
};

function diarizedResponse() {
  return [
    {
      results: [
        {
          alternatives: [
            {
              transcript: 'Hello world from me',
              confidence: 0.93,
              words: [
                { word: 'Hello', startOffset: '0s', endOffset: '0.5s', confidence: 0.95, speakerLabel: 1 },
                { word: 'world', startOffset: '0.5s', endOffset: '1.0s', confidence: 0.92, speakerLabel: 1 },
                { word: 'from', startOffset: '1.0s', endOffset: '1.3s', confidence: 0.88, speakerLabel: 2 },
                { word: 'me', startOffset: '1.3s', endOffset: '1.5s', confidence: 0.91, speakerLabel: 2 },
              ],
            },
          ],
        },
      ],
    },
  ];
}

function noDiarizationResponse() {
  return [
    {
      results: [
        {
          alternatives: [
            {
              transcript: 'Simple transcript',
              confidence: 0.95,
              words: [
                { word: 'Simple', startOffset: '0s', endOffset: '0.5s', confidence: 0.95, speakerLabel: 0 },
                { word: 'transcript', startOffset: '0.5s', endOffset: '1.2s', confidence: 0.94, speakerLabel: 0 },
              ],
            },
          ],
        },
      ],
    },
  ];
}

function noWordTimingResponse() {
  return [
    {
      results: [
        {
          alternatives: [
            {
              transcript: 'A transcript without word timing',
              confidence: 0.90,
            },
          ],
        },
      ],
    },
  ];
}

function protobufDurationResponse() {
  return [
    {
      results: [
        {
          alternatives: [
            {
              transcript: 'Protobuf duration test',
              confidence: 0.9,
              words: [
                {
                  word: 'Protobuf',
                  startOffset: { seconds: 1, nanos: 500000000 },
                  endOffset: { seconds: 2, nanos: 0 },
                  confidence: 0.9,
                  speakerLabel: 0,
                },
                {
                  word: 'duration',
                  startOffset: { seconds: 2, nanos: 0 },
                  endOffset: { seconds: 3, nanos: 250000000 },
                  confidence: 0.88,
                  speakerLabel: 0,
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

// ── Tests ────────────────────────────────────────────────────────────

describe('GoogleSttTranscriptionAdapter', () => {
  let adapter: GoogleSttTranscriptionAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new GoogleSttTranscriptionAdapter('test-project-id');
  });

  it('throws when projectId is empty', () => {
    expect(() => new GoogleSttTranscriptionAdapter('')).toThrow(
      'GOOGLE_CLOUD_PROJECT is required',
    );
  });

  // ── Chirp model configuration ─────────────────────────────────────

  describe('Chirp model configuration', () => {
    it('uses Chirp model for transcription', async () => {
      mockRecognize.mockResolvedValue(noDiarizationResponse());

      await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(mockRecognize).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            model: 'chirp',
          }),
        }),
      );
    });

    it('configures diarization when enabled', async () => {
      mockRecognize.mockResolvedValue(noDiarizationResponse());

      await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(mockRecognize).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            features: expect.objectContaining({
              enableAutomaticPunctuation: true,
              enableWordTimeOffsets: true,
              diarizationConfig: {
                minSpeakerCount: 1,
                maxSpeakerCount: 10,
              },
            }),
          }),
        }),
      );
    });

    it('disables diarization when option is false', async () => {
      mockRecognize.mockResolvedValue(noDiarizationResponse());

      await adapter.transcribe(Buffer.from('audio'), {
        ...defaultOptions,
        enableDiarization: false,
      });

      expect(mockRecognize).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            features: expect.objectContaining({
              diarizationConfig: undefined,
            }),
          }),
        }),
      );
    });

    it('uses correct recognizer path with project ID', async () => {
      mockRecognize.mockResolvedValue(noDiarizationResponse());

      await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(mockRecognize).toHaveBeenCalledWith(
        expect.objectContaining({
          recognizer: 'projects/test-project-id/locations/global/recognizers/_',
        }),
      );
    });

    it('passes language code from options', async () => {
      mockRecognize.mockResolvedValue(noDiarizationResponse());

      await adapter.transcribe(Buffer.from('audio'), {
        ...defaultOptions,
        language: 'fr-FR',
      });

      expect(mockRecognize).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            languageCodes: ['fr-FR'],
          }),
        }),
      );
    });
  });

  // ── Response mapping ──────────────────────────────────────────────

  describe('response mapping to TranscriptSegment', () => {
    it('maps diarized response with speaker labels and timestamps', async () => {
      mockRecognize.mockResolvedValue(diarizedResponse());

      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(results).toHaveLength(2);

      // Speaker 1 group
      expect(results[0].speaker).toBe('Speaker 1');
      expect(results[0].speakerId).toBe('speaker_1');
      expect(results[0].text).toBe('Hello world');
      expect(results[0].startTime).toBe(0.0);
      expect(results[0].endTime).toBe(1.0);

      // Speaker 2 group
      expect(results[1].speaker).toBe('Speaker 2');
      expect(results[1].speakerId).toBe('speaker_2');
      expect(results[1].text).toBe('from me');
      expect(results[1].startTime).toBe(1.0);
      expect(results[1].endTime).toBe(1.5);
    });

    it('calculates average confidence for grouped words', async () => {
      mockRecognize.mockResolvedValue(diarizedResponse());

      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      // Speaker 1: (0.95 + 0.92) / 2 = 0.935
      expect(results[0].confidence).toBeCloseTo(0.935, 2);
      // Speaker 2: (0.88 + 0.91) / 2 = 0.895
      expect(results[1].confidence).toBeCloseTo(0.895, 2);
    });

    it('handles response without word-level timing', async () => {
      mockRecognize.mockResolvedValue(noWordTimingResponse());

      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(results).toHaveLength(1);
      expect(results[0].text).toBe('A transcript without word timing');
      expect(results[0].speaker).toBe('Speaker 0');
      expect(results[0].startTime).toBe(0);
      expect(results[0].endTime).toBe(0);
      expect(results[0].confidence).toBe(0.90);
    });

    it('parses protobuf Duration format (seconds + nanos)', async () => {
      mockRecognize.mockResolvedValue(protobufDurationResponse());

      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(results).toHaveLength(1);
      expect(results[0].startTime).toBe(1.5); // 1s + 500000000ns
      expect(results[0].endTime).toBe(3.25); // 3s + 250000000ns
    });

    it('returns empty array for empty results', async () => {
      mockRecognize.mockResolvedValue([{ results: [] }]);

      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(results).toEqual([]);
    });
  });

  // ── Batch and streaming modes ────────────────────────────────────

  describe('batch and streaming modes', () => {
    it('supports batch transcription via recognize()', async () => {
      mockRecognize.mockResolvedValue(noDiarizationResponse());

      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(results).toHaveLength(1);
      expect(mockRecognize).toHaveBeenCalledTimes(1);
    });
  });

  // ── Retry logic ──────────────────────────────────────────────────

  describe('retry logic — 3 attempts with backoff', () => {
    it('retries on gRPC UNAVAILABLE error (code 14)', async () => {
      const grpcError = Object.assign(new Error('UNAVAILABLE'), { code: 14 });
      mockRecognize
        .mockRejectedValueOnce(grpcError)
        .mockResolvedValueOnce(noDiarizationResponse());

      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(results).toHaveLength(1);
      expect(mockRecognize).toHaveBeenCalledTimes(2);
    });

    it('retries on gRPC DEADLINE_EXCEEDED error (code 4)', async () => {
      const grpcError = Object.assign(new Error('DEADLINE_EXCEEDED'), { code: 4 });
      mockRecognize
        .mockRejectedValueOnce(grpcError)
        .mockResolvedValueOnce(noDiarizationResponse());

      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(results).toHaveLength(1);
      expect(mockRecognize).toHaveBeenCalledTimes(2);
    });

    it('retries on gRPC INTERNAL error (code 13)', async () => {
      const grpcError = Object.assign(new Error('INTERNAL'), { code: 13 });
      mockRecognize
        .mockRejectedValueOnce(grpcError)
        .mockResolvedValueOnce(noDiarizationResponse());

      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(results).toHaveLength(1);
    });

    it('throws after 3 failed attempts on transient errors', async () => {
      mockRecognize.mockRejectedValue(new Error('unavailable'));

      await expect(adapter.transcribe(Buffer.from('audio'), defaultOptions)).rejects.toThrow(
        'unavailable',
      );

      expect(mockRecognize).toHaveBeenCalledTimes(3);
    });

    it('does not retry non-transient errors (e.g., PERMISSION_DENIED)', async () => {
      const permError = Object.assign(new Error('PERMISSION_DENIED'), { code: 7 });
      mockRecognize.mockRejectedValue(permError);

      await expect(adapter.transcribe(Buffer.from('audio'), defaultOptions)).rejects.toThrow(
        'PERMISSION_DENIED',
      );

      expect(mockRecognize).toHaveBeenCalledTimes(1);
    });
  });
});
