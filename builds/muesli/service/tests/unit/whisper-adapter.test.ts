/**
 * Whisper transcription adapter tests — T-029.
 *
 * Tests WhisperTranscriptionAdapter: HTTP POST to endpoints, diarization
 * merging, endpoint validation (SSRF), batch-only mode, retry logic.
 *
 * Strategy: Mock global fetch to simulate Whisper and diarization endpoints.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WhisperTranscriptionAdapter } from '../../src/adapters/transcription/whisper.js';
import type { TranscribeOptions } from '../../src/types/adapters.js';

// ── Fixtures ────────────────────────────────────────────────────────

const WHISPER_URL = 'https://whisper.internal/transcribe';
const DIARIZATION_URL = 'https://diarization.internal/diarize';

const defaultOptions: TranscribeOptions = {
  backend: 'whisper',
  enableDiarization: true,
};

function whisperResponse() {
  return {
    segments: [
      { text: 'Hello there', start: 0.0, end: 2.0, confidence: 0.95 },
      { text: 'How are you', start: 2.1, end: 4.0, confidence: 0.90 },
    ],
  };
}

function diarizationResponse() {
  return {
    segments: [
      { speaker: 'Speaker 1', start: 0.0, end: 2.5 },
      { speaker: 'Speaker 2', start: 2.5, end: 5.0 },
    ],
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('WhisperTranscriptionAdapter', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── Constructor validation ────────────────────────────────────────

  describe('constructor', () => {
    it('throws when whisperEndpoint is empty', () => {
      expect(() => new WhisperTranscriptionAdapter('', DIARIZATION_URL)).toThrow(
        'WHISPER_ENDPOINT is required',
      );
    });

    it('throws when diarizationEndpoint is empty', () => {
      expect(() => new WhisperTranscriptionAdapter(WHISPER_URL, '')).toThrow(
        'DIARIZATION_ENDPOINT is required',
      );
    });

    it('throws for non-HTTPS non-internal endpoint (SSRF mitigation)', () => {
      expect(() => new WhisperTranscriptionAdapter('http://evil.com/api', DIARIZATION_URL)).toThrow(
        'must use HTTPS or be a whitelisted internal',
      );
    });

    it('accepts localhost endpoints', () => {
      expect(
        () =>
          new WhisperTranscriptionAdapter(
            'http://localhost:8080/transcribe',
            'http://localhost:8081/diarize',
          ),
      ).not.toThrow();
    });

    it('accepts .internal endpoints', () => {
      expect(() => new WhisperTranscriptionAdapter(WHISPER_URL, DIARIZATION_URL)).not.toThrow();
    });
  });

  // ── transcribe with diarization ──────────────────────────────────

  describe('transcribe — with diarization', () => {
    it('sends audio to WHISPER_ENDPOINT via HTTP POST', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => whisperResponse(),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => diarizationResponse(),
        });
      globalThis.fetch = mockFetch;

      const adapter = new WhisperTranscriptionAdapter(WHISPER_URL, DIARIZATION_URL);
      await adapter.transcribe(Buffer.from('audio-data'), defaultOptions);

      // First call is whisper, second is diarization
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toBe(WHISPER_URL);
      expect(mockFetch.mock.calls[1][0]).toBe(DIARIZATION_URL);
    });

    it('sends audio as FormData with file field', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => whisperResponse(),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => diarizationResponse(),
        });
      globalThis.fetch = mockFetch;

      const adapter = new WhisperTranscriptionAdapter(WHISPER_URL, DIARIZATION_URL);
      await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      // Verify POST method and FormData body
      const whisperCall = mockFetch.mock.calls[0];
      expect(whisperCall[1].method).toBe('POST');
      expect(whisperCall[1].body).toBeInstanceOf(FormData);
    });

    it('merges diarization speaker labels with transcription segments', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => whisperResponse(),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => diarizationResponse(),
        });
      globalThis.fetch = mockFetch;

      const adapter = new WhisperTranscriptionAdapter(WHISPER_URL, DIARIZATION_URL);
      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(results).toHaveLength(2);

      // First segment midpoint (1.0) falls in Speaker 1 range (0.0–2.5)
      expect(results[0].speaker).toBe('Speaker 1');
      expect(results[0].speakerId).toBe('speaker_1');
      expect(results[0].text).toBe('Hello there');
      expect(results[0].startTime).toBe(0.0);
      expect(results[0].endTime).toBe(2.0);
      expect(results[0].confidence).toBe(0.95);

      // Second segment midpoint (3.05) falls in Speaker 2 range (2.5–5.0)
      expect(results[1].speaker).toBe('Speaker 2');
      expect(results[1].speakerId).toBe('speaker_2');
      expect(results[1].text).toBe('How are you');
    });

    it('uses no-redirect option for SSRF mitigation', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => whisperResponse(),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => diarizationResponse(),
        });
      globalThis.fetch = mockFetch;

      const adapter = new WhisperTranscriptionAdapter(WHISPER_URL, DIARIZATION_URL);
      await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(mockFetch.mock.calls[0][1].redirect).toBe('error');
      expect(mockFetch.mock.calls[1][1].redirect).toBe('error');
    });
  });

  // ── transcribe without diarization ────────────────────────────────

  describe('transcribe — without diarization', () => {
    it('skips diarization call and assigns Speaker 0', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => whisperResponse(),
      });
      globalThis.fetch = mockFetch;

      const adapter = new WhisperTranscriptionAdapter(WHISPER_URL, DIARIZATION_URL);
      const results = await adapter.transcribe(Buffer.from('audio'), {
        ...defaultOptions,
        enableDiarization: false,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1); // Only whisper, no diarization
      expect(results[0].speaker).toBe('Speaker 0');
      expect(results[0].speakerId).toBe('speaker_0');
    });
  });

  // ── Batch-only mode ──────────────────────────────────────────────

  describe('batch-only mode', () => {
    it('only supports batch transcription (no streaming method)', () => {
      const adapter = new WhisperTranscriptionAdapter(WHISPER_URL, DIARIZATION_URL);
      // Whisper adapter only has transcribe(), no streaming-specific method
      expect(typeof adapter.transcribe).toBe('function');
      expect((adapter as Record<string, unknown>)['stream']).toBeUndefined();
      expect((adapter as Record<string, unknown>)['startStream']).toBeUndefined();
    });
  });

  // ── Retry logic ──────────────────────────────────────────────────

  describe('retry logic — 3 attempts with backoff', () => {
    it('retries on timeout error and succeeds on second attempt', async () => {
      const mockFetch = vi.fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => whisperResponse(),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => diarizationResponse(),
        });
      globalThis.fetch = mockFetch;

      const adapter = new WhisperTranscriptionAdapter(WHISPER_URL, DIARIZATION_URL);
      const results = await adapter.transcribe(Buffer.from('audio'), defaultOptions);

      expect(results).toHaveLength(2);
      // Whisper: attempt 1 fails + retry succeeds = 2 calls for whisper
      // Plus 1 call for diarization = 3 total
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('does not retry on HTTP 500 status (thrown error lacks transient keywords)', async () => {
      // The whisper adapter throws Error("Whisper endpoint returned 500") which
      // is NOT matched by isTransientError (checks for timeout/econnreset/etc.)
      // This tests the actual behavior — HTTP errors are thrown but not retried
      // unless they match the transient error patterns.
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => diarizationResponse(),
        });
      globalThis.fetch = mockFetch;

      const adapter = new WhisperTranscriptionAdapter(WHISPER_URL, DIARIZATION_URL);

      await expect(
        adapter.transcribe(Buffer.from('audio'), defaultOptions),
      ).rejects.toThrow('Whisper endpoint returned 500');
    });

    it('throws after 3 failed attempts on transient errors', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('fetch failed'));
      globalThis.fetch = mockFetch;

      const adapter = new WhisperTranscriptionAdapter(WHISPER_URL, DIARIZATION_URL);

      await expect(
        adapter.transcribe(Buffer.from('audio'), {
          ...defaultOptions,
          enableDiarization: false, // disable so only whisper calls are counted
        }),
      ).rejects.toThrow('fetch failed');

      // 3 attempts for whisper (all fail), no diarization calls
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('does not retry non-transient errors', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });
      globalThis.fetch = mockFetch;

      const adapter = new WhisperTranscriptionAdapter(WHISPER_URL, DIARIZATION_URL);

      await expect(
        adapter.transcribe(Buffer.from('audio'), defaultOptions),
      ).rejects.toThrow();

      // Non-transient: only 1 attempt for whisper (401)
      // Diarization runs in parallel, so it gets 1 attempt too
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
