/**
 * Deepgram transcription adapter tests — T-029.
 *
 * Tests the DeepgramTranscriptionAdapter: unified TranscriptSegment output,
 * utterance and word-level fallback parsing, retry logic on transient failures.
 *
 * Strategy: Mock @deepgram/sdk via vi.mock (adapter wraps the SDK).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @deepgram/sdk ──────────────────────────────────────────────

const mockTranscribeFile = vi.fn();

vi.mock('@deepgram/sdk', () => {
  class MockDeepgramClient {
    listen = {
      v1: {
        media: {
          transcribeFile: mockTranscribeFile,
        },
      },
    };
  }
  return {
    DeepgramClient: MockDeepgramClient,
  };
});

import { DeepgramTranscriptionAdapter } from '../../src/adapters/transcription/deepgram.js';
import type { TranscribeOptions } from '../../src/types/adapters.js';

// ── Fixtures ────────────────────────────────────────────────────────

const defaultOptions: TranscribeOptions = {
  backend: 'deepgram',
  enableDiarization: true,
};

function utteranceResponse() {
  return {
    results: {
      utterances: [
        {
          speaker: 0,
          transcript: 'Hello from speaker zero',
          start: 0.0,
          end: 2.5,
          confidence: 0.95,
        },
        {
          speaker: 1,
          transcript: 'Hi there from speaker one',
          start: 2.6,
          end: 5.0,
          confidence: 0.92,
        },
      ],
    },
  };
}

function wordFallbackResponse() {
  return {
    results: {
      utterances: [],
      channels: [
        {
          alternatives: [
            {
              transcript: 'Hello world',
              confidence: 0.9,
              words: [
                { word: 'Hello', punctuated_word: 'Hello', start: 0.0, end: 0.5, confidence: 0.95, speaker: 0 },
                { word: 'world', punctuated_word: 'world', start: 0.5, end: 1.0, confidence: 0.90, speaker: 0 },
                { word: 'from', punctuated_word: 'from', start: 1.0, end: 1.2, confidence: 0.88, speaker: 1 },
                { word: 'me', punctuated_word: 'me', start: 1.2, end: 1.5, confidence: 0.92, speaker: 1 },
              ],
            },
          ],
        },
      ],
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('DeepgramTranscriptionAdapter', () => {
  let adapter: DeepgramTranscriptionAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new DeepgramTranscriptionAdapter('test-api-key');
  });

  it('throws when API key is empty', () => {
    expect(() => new DeepgramTranscriptionAdapter('')).toThrow('Deepgram API key is required');
  });

  describe('transcribe — utterance-based response', () => {
    it('returns unified TranscriptSegment array with speaker labels, timestamps, and confidence', async () => {
      mockTranscribeFile.mockResolvedValue(utteranceResponse());

      const results = await adapter.transcribe(Buffer.from('audio-data'), defaultOptions);

      expect(results).toHaveLength(2);

      expect(results[0]).toEqual({
        speaker: 'Speaker 0',
        speakerId: 'speaker_0',
        text: 'Hello from speaker zero',
        startTime: 0.0,
        endTime: 2.5,
        confidence: 0.95,
      });

      expect(results[1]).toEqual({
        speaker: 'Speaker 1',
        speakerId: 'speaker_1',
        text: 'Hi there from speaker one',
        startTime: 2.6,
        endTime: 5.0,
        confidence: 0.92,
      });
    });

    it('calls Deepgram with Nova-2 model and correct options', async () => {
      mockTranscribeFile.mockResolvedValue(utteranceResponse());

      await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(mockTranscribeFile).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          model: 'nova-2',
          diarize: true,
          punctuate: true,
          utterances: true,
          smart_format: true,
        }),
      );
    });

    it('uses language from options', async () => {
      mockTranscribeFile.mockResolvedValue(utteranceResponse());

      await adapter.transcribe(Buffer.from('audio'), {
        ...defaultOptions,
        language: 'es',
      });

      expect(mockTranscribeFile).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ language: 'es' }),
      );
    });
  });

  describe('transcribe — word-level fallback', () => {
    it('groups words by speaker when utterances are empty', async () => {
      mockTranscribeFile.mockResolvedValue(wordFallbackResponse());

      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(results).toHaveLength(2);
      expect(results[0].speaker).toBe('Speaker 0');
      expect(results[0].text).toBe('Hello world');
      expect(results[0].startTime).toBe(0.0);
      expect(results[0].endTime).toBe(1.0);

      expect(results[1].speaker).toBe('Speaker 1');
      expect(results[1].text).toBe('from me');
      expect(results[1].startTime).toBe(1.0);
      expect(results[1].endTime).toBe(1.5);
    });

    it('calculates average confidence for word groups', async () => {
      mockTranscribeFile.mockResolvedValue(wordFallbackResponse());

      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      // Speaker 0: (0.95 + 0.90) / 2 = 0.925
      expect(results[0].confidence).toBeCloseTo(0.925, 2);
      // Speaker 1: (0.88 + 0.92) / 2 = 0.90
      expect(results[1].confidence).toBeCloseTo(0.9, 2);
    });
  });

  describe('transcribe — empty response', () => {
    it('returns empty array for empty results', async () => {
      mockTranscribeFile.mockResolvedValue({ results: {} });

      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(results).toEqual([]);
    });
  });

  describe('streaming vs batch mode', () => {
    it('calls prerecorded (batch) transcription via transcribeFile', async () => {
      mockTranscribeFile.mockResolvedValue(utteranceResponse());

      await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(mockTranscribeFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry logic — 3 attempts with backoff', () => {
    it('retries on transient error (timeout) and succeeds on second attempt', async () => {
      mockTranscribeFile
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(utteranceResponse());

      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(results).toHaveLength(2);
      expect(mockTranscribeFile).toHaveBeenCalledTimes(2);
    });

    it('retries on 429 status code', async () => {
      const err429 = Object.assign(new Error('Rate limited'), { statusCode: 429 });
      mockTranscribeFile
        .mockRejectedValueOnce(err429)
        .mockResolvedValueOnce(utteranceResponse());

      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(results).toHaveLength(2);
      expect(mockTranscribeFile).toHaveBeenCalledTimes(2);
    });

    it('retries on 500 status code', async () => {
      const err500 = Object.assign(new Error('Internal'), { statusCode: 500 });
      mockTranscribeFile
        .mockRejectedValueOnce(err500)
        .mockResolvedValueOnce(utteranceResponse());

      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(results).toHaveLength(2);
    });

    it('throws after 3 failed attempts', async () => {
      const transientErr = new Error('socket hang up');
      mockTranscribeFile.mockRejectedValue(transientErr);

      await expect(adapter.transcribe(Buffer.from('audio'), defaultOptions)).rejects.toThrow(
        'socket hang up',
      );

      expect(mockTranscribeFile).toHaveBeenCalledTimes(3);
    });

    it('does not retry non-transient errors', async () => {
      const nonTransient = Object.assign(new Error('Invalid API key'), { statusCode: 401 });
      mockTranscribeFile.mockRejectedValue(nonTransient);

      await expect(adapter.transcribe(Buffer.from('audio'), defaultOptions)).rejects.toThrow(
        'Invalid API key',
      );

      expect(mockTranscribeFile).toHaveBeenCalledTimes(1);
    });
  });
});
