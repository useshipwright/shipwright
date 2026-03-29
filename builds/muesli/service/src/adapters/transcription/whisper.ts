/**
 * Self-hosted Whisper transcription adapter (ADR-005).
 *
 * POSTs audio to WHISPER_ENDPOINT for transcription and
 * DIARIZATION_ENDPOINT for speaker diarization, then merges results.
 * Supports batch mode only.
 * Implements retry logic (3 attempts with exponential backoff) on transient failures.
 *
 * Endpoint validation: HTTPS or whitelisted internal addresses required.
 * No redirect following per threat model (SSRF mitigation).
 */

import type { TranscriptionAdapter, TranscribeOptions, TranscriptionResult } from '../../types/adapters.js';
import { logger } from '../../logger.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 300_000; // 5 minutes for large audio files

/**
 * Validate that an endpoint URL is safe (HTTPS or whitelisted internal).
 * Prevents SSRF via user-controlled endpoint configuration.
 */
function validateEndpoint(url: string, name: string): void {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const isLocalhost =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1' ||
    parsed.hostname.endsWith('.internal') ||
    parsed.hostname.endsWith('.local');

  if (!isHttps && !isLocalhost) {
    throw new Error(
      `${name} must use HTTPS or be a whitelisted internal address. Got: ${parsed.protocol}//${parsed.hostname}`,
    );
  }
}

function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('socket hang up') || msg.includes('fetch failed')) {
      return true;
    }
  }
  return false;
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES && isTransientError(err)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn({ attempt, delay, err }, `${label}: transient failure, retrying`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export class WhisperTranscriptionAdapter implements TranscriptionAdapter {
  private readonly whisperEndpoint: string;
  private readonly diarizationEndpoint: string;

  constructor(whisperEndpoint: string, diarizationEndpoint: string) {
    if (!whisperEndpoint) {
      throw new Error('WHISPER_ENDPOINT is required for Whisper backend');
    }
    if (!diarizationEndpoint) {
      throw new Error('DIARIZATION_ENDPOINT is required for Whisper backend');
    }

    validateEndpoint(whisperEndpoint, 'WHISPER_ENDPOINT');
    validateEndpoint(diarizationEndpoint, 'DIARIZATION_ENDPOINT');

    this.whisperEndpoint = whisperEndpoint;
    this.diarizationEndpoint = diarizationEndpoint;
  }

  async transcribe(audio: Buffer, options: TranscribeOptions): Promise<TranscriptionResult[]> {
    const [transcription, diarization] = await Promise.all([
      this.callWhisper(audio, options),
      options.enableDiarization !== false
        ? this.callDiarization(audio)
        : Promise.resolve(null),
    ]);

    if (!diarization) {
      return transcription.segments.map((seg) => ({
        speaker: 'Speaker 0',
        speakerId: 'speaker_0',
        text: seg.text,
        startTime: seg.start,
        endTime: seg.end,
        confidence: seg.confidence ?? 0,
      }));
    }

    return this.mergeResults(transcription.segments, diarization.segments);
  }

  private async callWhisper(
    audio: Buffer,
    options: TranscribeOptions,
  ): Promise<WhisperResponse> {
    return withRetry(async () => {
      const formData = new FormData();
      formData.append('file', new Blob([new Uint8Array(audio)]), 'audio.wav');
      if (options.language) {
        formData.append('language', options.language);
      }

      const response = await fetch(this.whisperEndpoint, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error', // Do not follow redirects (SSRF mitigation)
      });

      if (!response.ok) {
        const err = new Error(`Whisper endpoint returned ${response.status}`);
        if (isTransientStatus(response.status)) {
          throw err;
        }
        throw err;
      }

      return (await response.json()) as WhisperResponse;
    }, 'whisper.transcribe');
  }

  private async callDiarization(audio: Buffer): Promise<DiarizationResponse> {
    return withRetry(async () => {
      const formData = new FormData();
      formData.append('file', new Blob([new Uint8Array(audio)]), 'audio.wav');

      const response = await fetch(this.diarizationEndpoint, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error', // Do not follow redirects (SSRF mitigation)
      });

      if (!response.ok) {
        const err = new Error(`Diarization endpoint returned ${response.status}`);
        if (isTransientStatus(response.status)) {
          throw err;
        }
        throw err;
      }

      return (await response.json()) as DiarizationResponse;
    }, 'whisper.diarization');
  }

  /**
   * Merge Whisper transcription segments with pyannote diarization segments.
   * Assigns speaker labels based on temporal overlap.
   */
  private mergeResults(
    transcriptSegments: WhisperSegment[],
    diarizationSegments: DiarizationSegment[],
  ): TranscriptionResult[] {
    return transcriptSegments.map((seg) => {
      const midpoint = (seg.start + seg.end) / 2;
      const matchingSpeaker = diarizationSegments.find(
        (d) => d.start <= midpoint && d.end >= midpoint,
      );
      const speakerLabel = matchingSpeaker?.speaker ?? 'Speaker 0';
      const speakerId = speakerLabel.toLowerCase().replace(/\s+/g, '_');

      return {
        speaker: speakerLabel,
        speakerId,
        text: seg.text,
        startTime: seg.start,
        endTime: seg.end,
        confidence: seg.confidence ?? 0,
      };
    });
  }
}

// Expected response shapes from self-hosted Whisper and pyannote endpoints

interface WhisperSegment {
  text: string;
  start: number;
  end: number;
  confidence?: number;
}

interface WhisperResponse {
  segments: WhisperSegment[];
}

interface DiarizationSegment {
  speaker: string;
  start: number;
  end: number;
}

interface DiarizationResponse {
  segments: DiarizationSegment[];
}
