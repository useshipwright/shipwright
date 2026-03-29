/**
 * Audio processing pipeline service.
 *
 * Handles async audio transcription triggered by Pub/Sub push delivery
 * to /internal/process-audio. Downloads audio from GCS, calls transcription
 * adapter, writes transcript segments, calculates speaker stats, and
 * optionally triggers note generation.
 *
 * Pub/Sub delivery config: 5 attempts (Pub/Sub minimum is 5, not 3) with
 * exponential backoff (10s-600s). Dead-letter topic after exhaustion.
 * See: PRD validation mismatch — Pub/Sub maxDeliveryAttempts range is 5-100.
 */

import crypto from 'node:crypto';
import { logger } from '../logger.js';
import type {
  FirestoreAdapter,
  TranscriptionAdapter,
  GCSAdapter,
} from '../types/adapters.js';
import type {
  TranscriptSegment,
  Speaker,
  SpeakerStats,
  TranscriptionBackend,
} from '../types/domain.js';

// ── Constants ────────────────────────────────────────────────────────

/**
 * Maximum Pub/Sub delivery attempts before dead-lettering.
 * Pub/Sub enforces a minimum of 5 (range: 5-100).
 * Previously set to 3, corrected per PRD validation report.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** Batch size for writing transcript segments to Firestore. */
const SEGMENT_BATCH_SIZE = 500;

// ── Types ────────────────────────────────────────────────────────────

export interface ProcessAudioMessage {
  meetingId: string;
  userId: string;
  audioPath: string;
  backend?: TranscriptionBackend;
}

export interface AudioProcessorDeps {
  firestore: FirestoreAdapter;
  gcs: GCSAdapter;
  createTranscriptionAdapter: (backend: TranscriptionBackend) => TranscriptionAdapter;
  generateNotes?: (params: { userId: string; meetingId: string }) => Promise<unknown>;
}

// ── Helpers ──────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function calculateSpeakerStats(
  segments: TranscriptSegment[],
): SpeakerStats {
  const stats: SpeakerStats = {};
  for (const seg of segments) {
    if (!stats[seg.speakerId]) {
      stats[seg.speakerId] = { talkTimeSeconds: 0, segmentCount: 0 };
    }
    stats[seg.speakerId].talkTimeSeconds += seg.endTime - seg.startTime;
    stats[seg.speakerId].segmentCount += 1;
  }
  return stats;
}

function extractUniqueSpeakers(segments: TranscriptSegment[]): Speaker[] {
  const seen = new Map<string, Speaker>();
  for (const seg of segments) {
    if (!seen.has(seg.speakerId)) {
      seen.set(seg.speakerId, {
        id: seg.speakerId,
        label: seg.speaker,
      });
    }
  }
  return Array.from(seen.values());
}

// ── Pipeline ─────────────────────────────────────────────────────────

/**
 * Process an audio file from a Pub/Sub push message.
 *
 * Pipeline steps:
 * 1. Check idempotency — skip if meeting is already ready or processing
 * 2. Update meeting status to processing
 * 3. Download audio from GCS
 * 4. Call transcription adapter
 * 5. Write transcript segments to Firestore (batch writes)
 * 6. Calculate speaker stats and write speakers subcollection
 * 7. Optionally trigger note generation if autoTranscribe enabled
 * 8. Update meeting status (processing -> ready | failed)
 *
 * Idempotency: checks meeting status before processing to handle
 * duplicate Pub/Sub deliveries (up to MAX_DELIVERY_ATTEMPTS = 5).
 */
export async function processAudio(
  message: ProcessAudioMessage,
  deps: AudioProcessorDeps,
): Promise<void> {
  const { meetingId, userId, audioPath, backend } = message;
  const { firestore, gcs, createTranscriptionAdapter: createAdapter } = deps;
  const log = logger.child({ meetingId, userId });

  // 1. Idempotency check — prevent duplicate processing from Pub/Sub redelivery
  const meeting = await firestore.getMeeting(meetingId, userId);
  if (!meeting) {
    log.warn('Meeting not found — skipping audio processing');
    return;
  }
  if (meeting.status === 'ready') {
    log.info('Meeting already processed — skipping (idempotent)');
    return;
  }

  // 2. Transition to processing
  try {
    await firestore.updateMeeting(meetingId, userId, {
      status: 'processing',
      updatedAt: new Date(),
    });
  } catch (err) {
    log.error({ err }, 'Failed to update meeting status to processing');
    throw err;
  }

  try {
    // 3. Download audio from GCS (direct download, no signed URL needed)
    log.info({ audioPath }, 'Downloading audio from GCS');
    const audioBuffer = await gcs.download(audioPath);
    log.info({ audioPath, bytes: audioBuffer.length }, 'Audio downloaded');

    // 4. Call transcription adapter
    const selectedBackend: TranscriptionBackend = backend ?? 'deepgram';
    log.info({ backend: selectedBackend }, 'Starting transcription');
    const adapter = createAdapter(selectedBackend);
    const results = await adapter.transcribe(audioBuffer, {
      backend: selectedBackend,
      enableDiarization: true,
    });
    log.info({ segmentCount: results.length }, 'Transcription complete');

    // 5. Convert results to TranscriptSegment and write in batches
    const segments: TranscriptSegment[] = results.map((r) => ({
      id: crypto.randomUUID(),
      speaker: r.speaker,
      speakerId: r.speakerId,
      text: r.text,
      startTime: r.startTime,
      endTime: r.endTime,
      confidence: r.confidence,
      channel: 'system_audio' as const,
      isUserNote: false,
      searchTokens: tokenize(r.text),
    }));

    // Batch write segments
    for (let i = 0; i < segments.length; i += SEGMENT_BATCH_SIZE) {
      const batch = segments.slice(i, i + SEGMENT_BATCH_SIZE);
      await firestore.batchWriteSegments(meetingId, batch);
      log.info(
        { batchStart: i, batchSize: batch.length },
        'Segment batch written',
      );
    }

    // 6. Calculate speaker stats
    const speakerStats = calculateSpeakerStats(segments);
    const speakers = extractUniqueSpeakers(segments);

    // Write speakers to subcollection (reuse batchWriteSegments pattern —
    // the firestore adapter handles speakers via updateSpeaker per speaker)
    for (const speaker of speakers) {
      await firestore.updateSpeaker(meetingId, speaker.id, userId, {
        label: speaker.label,
      });
    }

    // Calculate duration from segments
    const maxEndTime = segments.reduce(
      (max, seg) => Math.max(max, seg.endTime),
      0,
    );

    // 7. Update meeting to ready with stats
    await firestore.updateMeeting(meetingId, userId, {
      status: 'ready',
      speakerStats,
      durationSeconds: maxEndTime > 0 ? Math.ceil(maxEndTime) : undefined,
      endedAt: new Date(),
      updatedAt: new Date(),
    });
    log.info('Meeting status updated to ready');

    // 8. Optionally trigger note generation if autoTranscribe is enabled
    if (deps.generateNotes) {
      const user = await firestore.getUser(userId);
      if (user?.autoTranscribe) {
        log.info('Auto-transcribe enabled — triggering note generation');
        try {
          await deps.generateNotes({ userId, meetingId });
          log.info('Note generation completed');
        } catch (noteErr) {
          // Note generation failure should not fail the processing pipeline
          log.warn({ err: noteErr }, 'Auto note generation failed — meeting is still ready');
        }
      }
    }
  } catch (err) {
    // Mark meeting as failed with error details
    log.error({ err }, 'Audio processing failed');
    const errorMessage = err instanceof Error ? err.message : 'Unknown processing error';
    await firestore.updateMeeting(meetingId, userId, {
      status: 'failed',
      error: errorMessage,
      updatedAt: new Date(),
    }).catch((updateErr) => {
      log.error({ err: updateErr }, 'Failed to update meeting status to failed');
    });
    throw err;
  }
}
