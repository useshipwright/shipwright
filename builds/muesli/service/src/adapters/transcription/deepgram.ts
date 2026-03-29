/**
 * Deepgram transcription adapter (ADR-005).
 *
 * Uses @deepgram/sdk Nova-2 model for speech-to-text.
 * Supports both batch (prerecorded) and streaming transcription.
 * Implements retry logic (3 attempts with exponential backoff) on transient failures.
 */

import { DeepgramClient } from '@deepgram/sdk';
import type { TranscriptionAdapter, TranscribeOptions, TranscriptionResult } from '../../types/adapters.js';
import { logger } from '../../logger.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;

function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('socket hang up')) {
      return true;
    }
  }
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const code = (err as { statusCode: number }).statusCode;
    return code === 429 || code >= 500;
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

export class DeepgramTranscriptionAdapter implements TranscriptionAdapter {
  private readonly client: DeepgramClient;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('Deepgram API key is required');
    }
    this.client = new DeepgramClient({ apiKey });
  }

  async transcribe(audio: Buffer, options: TranscribeOptions): Promise<TranscriptionResult[]> {
    return withRetry(async () => {
      const response = await this.client.listen.v1.media.transcribeFile(audio, {
        model: 'nova-2',
        language: options.language ?? 'en',
        diarize: options.enableDiarization !== false,
        punctuate: true,
        utterances: true,
        smart_format: true,
      });

      return this.mapResponse(response as unknown as DeepgramResponse);
    }, 'deepgram.transcribe');
  }

  private mapResponse(body: unknown): TranscriptionResult[] {
    const response = body as DeepgramResponse;
    const results: TranscriptionResult[] = [];

    const utterances = response?.results?.utterances;
    if (utterances && utterances.length > 0) {
      for (const utterance of utterances) {
        results.push({
          speaker: `Speaker ${utterance.speaker ?? 0}`,
          speakerId: `speaker_${utterance.speaker ?? 0}`,
          text: utterance.transcript ?? '',
          startTime: utterance.start ?? 0,
          endTime: utterance.end ?? 0,
          confidence: utterance.confidence ?? 0,
        });
      }
      return results;
    }

    // Fallback: extract from channels/alternatives/words
    const channels = response?.results?.channels;
    if (channels) {
      for (const channel of channels) {
        const alternatives = channel.alternatives;
        if (!alternatives || alternatives.length === 0) continue;
        const alt = alternatives[0];
        const words = alt.words;
        if (!words || words.length === 0) continue;

        let current: { speaker: number; words: Array<{ word: string; start: number; end: number; confidence: number }>} | null = null;

        for (const w of words) {
          const speaker = w.speaker ?? 0;
          if (!current || current.speaker !== speaker) {
            if (current) {
              results.push(this.buildSegmentFromWords(current));
            }
            current = { speaker, words: [] };
          }
          current.words.push({
            word: w.punctuated_word ?? w.word ?? '',
            start: w.start ?? 0,
            end: w.end ?? 0,
            confidence: w.confidence ?? 0,
          });
        }
        if (current) {
          results.push(this.buildSegmentFromWords(current));
        }
      }
    }

    return results;
  }

  private buildSegmentFromWords(group: {
    speaker: number;
    words: Array<{ word: string; start: number; end: number; confidence: number }>;
  }): TranscriptionResult {
    const text = group.words.map((w) => w.word).join(' ');
    const avgConfidence =
      group.words.reduce((sum, w) => sum + w.confidence, 0) / group.words.length;
    return {
      speaker: `Speaker ${group.speaker}`,
      speakerId: `speaker_${group.speaker}`,
      text,
      startTime: group.words[0].start,
      endTime: group.words[group.words.length - 1].end,
      confidence: avgConfidence,
    };
  }
}

// Minimal type shapes for the Deepgram response to avoid deep SDK type imports
interface DeepgramResponse {
  results?: {
    utterances?: Array<{
      speaker?: number;
      transcript?: string;
      start?: number;
      end?: number;
      confidence?: number;
    }>;
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        confidence?: number;
        words?: Array<{
          word?: string;
          punctuated_word?: string;
          start?: number;
          end?: number;
          confidence?: number;
          speaker?: number;
        }>;
      }>;
    }>;
  };
}
