/**
 * Transcript length limit for AI generation (T-042).
 *
 * Prevents context window overflow and cost abuse by truncating transcripts
 * that exceed a configurable maximum token count before sending to Claude.
 * Logs a warning when truncation occurs.
 *
 * Token estimation uses a ~4 characters per token heuristic (standard for
 * English text with the Claude tokenizer). This is intentionally conservative
 * to avoid exceeding the actual limit.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { TranscriptSegment } from '../types/domain.js';

/** Approximate characters per token for Claude models. */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate the token count of a string using character-based heuristic.
 * Conservative: slightly overestimates to prevent context window overflow.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface TruncationResult {
  /** Segments included within the token budget. */
  segments: TranscriptSegment[];
  /** Whether any segments were dropped due to the limit. */
  wasTruncated: boolean;
  /** Estimated token count of the included segments. */
  estimatedTokens: number;
  /** Total segments before truncation. */
  originalSegmentCount: number;
}

/**
 * Truncate transcript segments to fit within the configured max token limit.
 *
 * Segments are included in order (by time) until the budget is exhausted.
 * When truncation occurs, a warning is logged with meeting context.
 */
export function truncateTranscript(
  segments: TranscriptSegment[],
  meetingId: string,
  options?: { maxTokens?: number },
): TruncationResult {
  const maxTokens = options?.maxTokens ?? config.maxTranscriptTokens;
  let runningTokens = 0;
  const included: TranscriptSegment[] = [];

  for (const segment of segments) {
    const segmentTokens = estimateTokenCount(segment.text);
    if (runningTokens + segmentTokens > maxTokens && included.length > 0) {
      break;
    }
    included.push(segment);
    runningTokens += segmentTokens;
  }

  const wasTruncated = included.length < segments.length;

  if (wasTruncated) {
    logger.warn(
      {
        meetingId,
        originalSegments: segments.length,
        includedSegments: included.length,
        estimatedTokens: runningTokens,
        maxTokens,
      },
      'Transcript truncated for AI generation — exceeded max token limit',
    );
  }

  return {
    segments: included,
    wasTruncated,
    estimatedTokens: runningTokens,
    originalSegmentCount: segments.length,
  };
}

/**
 * Build a transcript text block from segments, truncated to the token limit.
 * Returns the formatted text and truncation metadata.
 */
export function buildTruncatedTranscriptText(
  segments: TranscriptSegment[],
  meetingId: string,
  options?: { maxTokens?: number },
): { text: string; wasTruncated: boolean; estimatedTokens: number } {
  const result = truncateTranscript(segments, meetingId, options);

  const text = result.segments
    .map((s) => `[${s.speaker}] ${s.text}`)
    .join('\n');

  return {
    text,
    wasTruncated: result.wasTruncated,
    estimatedTokens: result.estimatedTokens,
  };
}
