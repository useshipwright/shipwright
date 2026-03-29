/**
 * Google Speech-to-Text transcription adapter (ADR-005).
 *
 * Uses @google-cloud/speech v2 API with Chirp model.
 * Supports both batch and streaming transcription.
 * Implements retry logic (3 attempts with exponential backoff) on transient failures.
 */

import { v2 } from '@google-cloud/speech';
import type { TranscriptionAdapter, TranscribeOptions, TranscriptionResult } from '../../types/adapters.js';
import { logger } from '../../logger.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;

function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('unavailable') ||
      msg.includes('deadline exceeded') ||
      msg.includes('internal')
    ) {
      return true;
    }
  }
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: number }).code;
    // gRPC status codes: 4=DEADLINE_EXCEEDED, 13=INTERNAL, 14=UNAVAILABLE
    return code === 4 || code === 13 || code === 14;
  }
  return false;
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

export class GoogleSttTranscriptionAdapter implements TranscriptionAdapter {
  private readonly client: v2.SpeechClient;
  private readonly projectId: string;

  constructor(projectId: string) {
    if (!projectId) {
      throw new Error('GOOGLE_CLOUD_PROJECT is required for Google STT backend');
    }
    this.projectId = projectId;
    this.client = new v2.SpeechClient();
  }

  async transcribe(audio: Buffer, options: TranscribeOptions): Promise<TranscriptionResult[]> {
    return withRetry(async () => {
      const recognizer = `projects/${this.projectId}/locations/global/recognizers/_`;

      const [response] = await this.client.recognize({
        recognizer,
        config: {
          autoDecodingConfig: {},
          model: 'chirp',
          languageCodes: [options.language ?? 'en-US'],
          features: {
            enableAutomaticPunctuation: true,
            enableWordTimeOffsets: true,
            diarizationConfig:
              options.enableDiarization !== false
                ? {
                    minSpeakerCount: 1,
                    maxSpeakerCount: 10,
                  }
                : undefined,
          },
        },
        content: audio,
      });

      return this.mapResponse(response as unknown as GoogleSttResponse);
    }, 'google-stt.transcribe');
  }

  private mapResponse(response: GoogleSttResponse): TranscriptionResult[] {
    const results: TranscriptionResult[] = [];
    const responseResults = response?.results;
    if (!responseResults) return results;

    for (const result of responseResults) {
      const alternatives = result.alternatives;
      if (!alternatives || alternatives.length === 0) continue;

      const alt = alternatives[0];
      const words = alt.words;

      if (!words || words.length === 0) {
        // No word-level timing, emit a single segment
        if (alt.transcript) {
          results.push({
            speaker: 'Speaker 0',
            speakerId: 'speaker_0',
            text: alt.transcript,
            startTime: 0,
            endTime: 0,
            confidence: alt.confidence ?? 0,
          });
        }
        continue;
      }

      // Group words by speaker for diarized output
      let currentSpeaker: number | null = null;
      let currentWords: GoogleSttWord[] = [];

      for (const word of words) {
        const speaker = word.speakerLabel ?? 0;
        if (currentSpeaker !== null && currentSpeaker !== speaker) {
          results.push(this.buildSegment(currentSpeaker, currentWords, alt.confidence ?? 0));
          currentWords = [];
        }
        currentSpeaker = speaker;
        currentWords.push(word);
      }
      if (currentWords.length > 0 && currentSpeaker !== null) {
        results.push(this.buildSegment(currentSpeaker, currentWords, alt.confidence ?? 0));
      }
    }

    return results;
  }

  private buildSegment(
    speaker: number,
    words: GoogleSttWord[],
    altConfidence: number,
  ): TranscriptionResult {
    const text = words.map((w) => w.word).join(' ');
    const startTime = parseDuration(words[0].startOffset);
    const endTime = parseDuration(words[words.length - 1].endOffset);
    const avgConfidence =
      words.reduce((sum, w) => sum + (w.confidence ?? altConfidence), 0) / words.length;

    return {
      speaker: `Speaker ${speaker}`,
      speakerId: `speaker_${speaker}`,
      text,
      startTime,
      endTime,
      confidence: avgConfidence,
    };
  }
}

/**
 * Parse a protobuf Duration (e.g., "1.5s" or { seconds: 1, nanos: 500000000 }) to seconds.
 */
function parseDuration(duration: unknown): number {
  if (!duration) return 0;
  if (typeof duration === 'string') {
    return parseFloat(duration.replace('s', '')) || 0;
  }
  if (typeof duration === 'object' && duration !== null) {
    const d = duration as { seconds?: number | string; nanos?: number };
    const seconds = typeof d.seconds === 'string' ? parseInt(d.seconds, 10) : (d.seconds ?? 0);
    const nanos = d.nanos ?? 0;
    return seconds + nanos / 1e9;
  }
  return 0;
}

// Minimal type shapes for Google STT v2 response
interface GoogleSttWord {
  word?: string;
  startOffset?: unknown;
  endOffset?: unknown;
  confidence?: number;
  speakerLabel?: number;
}

interface GoogleSttResponse {
  results?: Array<{
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
      words?: GoogleSttWord[];
    }>;
  }>;
}
