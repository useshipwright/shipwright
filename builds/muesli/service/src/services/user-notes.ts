/**
 * User notes service — business logic for user-typed notes during meetings.
 *
 * Notes are stored as transcript segments with isUserNote=true in the
 * meeting's segments subcollection (ADR-004). They serve as priority
 * anchors for AI note generation.
 *
 * All operations are scoped by userId for tenant isolation (IDOR prevention).
 */

import type { FirestoreAdapter } from '../types/adapters.js';
import type { TranscriptSegment } from '../types/domain.js';

// ── Service interface ───────────────────────────────────────────────

export interface UserNotesServiceDeps {
  firestore: FirestoreAdapter;
}

export interface CreateUserNoteParams {
  userId: string;
  meetingId: string;
  text: string;
  timestamp?: number;
}

// ── Service factory ─────────────────────────────────────────────────

export function createUserNotesService(deps: UserNotesServiceDeps) {
  const { firestore } = deps;

  return {
    /**
     * Store a user-typed note as a transcript segment with isUserNote=true.
     * Verifies meeting ownership before writing.
     */
    async create(params: CreateUserNoteParams): Promise<TranscriptSegment | null> {
      const meeting = await firestore.getMeeting(params.meetingId, params.userId);
      if (!meeting) return null;

      const timestamp = params.timestamp ?? 0;

      const segment: TranscriptSegment = {
        id: crypto.randomUUID(),
        speaker: 'User',
        speakerId: 'user',
        text: params.text,
        startTime: timestamp,
        endTime: timestamp,
        channel: 'user_input',
        isUserNote: true,
        searchTokens: params.text
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean),
      };

      await firestore.batchWriteSegments(params.meetingId, [segment]);
      return segment;
    },

    /**
     * Get all user notes for a meeting, ordered by startTime.
     * Verifies meeting ownership before reading.
     */
    async list(
      meetingId: string,
      userId: string,
    ): Promise<TranscriptSegment[]> {
      const meeting = await firestore.getMeeting(meetingId, userId);
      if (!meeting) return [];

      const segments = await firestore.getSegments(meetingId, userId);
      return segments
        .filter((s) => s.isUserNote)
        .sort((a, b) => a.startTime - b.startTime);
    },
  };
}

export type UserNotesService = ReturnType<typeof createUserNotesService>;
