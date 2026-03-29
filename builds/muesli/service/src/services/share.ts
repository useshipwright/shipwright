/**
 * Share service layer — business logic for creating, viewing, listing,
 * and revoking shareable meeting note links.
 *
 * SECURITY:
 * - Share IDs use crypto.randomUUID() for 128-bit cryptographic randomness
 * - All mutations scoped by userId for tenant isolation (IDOR prevention)
 * - Expiration checked before returning share data
 * - Identical 404 for non-existent, expired, and revoked shares (no info leakage)
 * - Public share view strips attendee emails (names only)
 * - View count incremented atomically on valid access
 */

import type { FirestoreAdapter, GCSAdapter } from '../types/adapters.js';
import type {
  Share,
  ShareAccessMode,
  TranscriptSegment,
  Attendee,
} from '../types/domain.js';

// ── Service interface ───────────────────────────────────────────────

export interface ShareServiceDeps {
  firestore: FirestoreAdapter;
  gcs?: GCSAdapter;
}

export interface CreateShareParams {
  userId: string;
  meetingId: string;
  accessMode: ShareAccessMode;
  allowedEmails?: string[];
  includeTranscript: boolean;
  includeAudio: boolean;
  expiresAt?: Date;
}

/** Data returned when viewing a shared meeting. */
export interface ShareViewData {
  shareId: string;
  meeting: {
    title: string;
    date: Date | undefined;
    attendees: { name: string }[];
  };
  notes: {
    sections: { heading: string; content: string }[];
    generatedAt: Date;
  } | null;
  transcript?: TranscriptSegment[];
  audioUrl?: string;
}

// ── Service factory ─────────────────────────────────────────────────

export function createShareService(deps: ShareServiceDeps) {
  const { firestore, gcs } = deps;

  return {
    /**
     * Create a shareable link for a meeting.
     * Verifies meeting ownership before creating the share.
     */
    async create(params: CreateShareParams): Promise<Share | null> {
      // Verify meeting exists and belongs to user
      const meeting = await firestore.getMeeting(params.meetingId, params.userId);
      if (!meeting) return null;

      // Validate specific_emails requires allowedEmails
      if (params.accessMode === 'specific_emails' && (!params.allowedEmails || params.allowedEmails.length === 0)) {
        throw new Error('allowedEmails required for specific_emails access mode');
      }

      const now = new Date();
      const share: Share = {
        shareId: crypto.randomUUID(),
        meetingId: params.meetingId,
        userId: params.userId,
        accessMode: params.accessMode,
        allowedEmails: params.accessMode === 'specific_emails' ? params.allowedEmails : undefined,
        includeTranscript: params.includeTranscript,
        includeAudio: params.includeAudio,
        expiresAt: params.expiresAt,
        viewCount: 0,
        createdAt: now,
      };

      await firestore.createShare(share);
      return share;
    },

    /**
     * View a shared meeting's content.
     * Returns null if the share doesn't exist or is expired (identical 404 behavior).
     * Increments view count on successful access.
     * Strips attendee emails from the response.
     */
    async view(shareId: string): Promise<ShareViewData | null> {
      const share = await firestore.getShare(shareId);
      if (!share) return null;

      // Check expiration — treat as non-existent
      if (share.expiresAt && share.expiresAt < new Date()) return null;

      // Fetch meeting data (use system-level access since this is a share view)
      // We look up the meeting using the share owner's userId
      const meeting = await firestore.getMeeting(share.meetingId, share.userId);
      if (!meeting) return null;

      // Fetch latest notes
      const latestNote = await firestore.getLatestNote(share.meetingId, share.userId);

      // Build response — strip attendee emails per security requirements
      const result: ShareViewData = {
        shareId: share.shareId,
        meeting: {
          title: meeting.title,
          date: meeting.startedAt,
          attendees: meeting.attendees.map((a: Attendee) => ({ name: a.name })),
        },
        notes: latestNote
          ? {
              sections: latestNote.sections,
              generatedAt: latestNote.generatedAt,
            }
          : null,
      };

      // Optionally include transcript
      if (share.includeTranscript) {
        result.transcript = await firestore.getSegments(share.meetingId, share.userId);
      }

      // Optionally include audio signed URL
      if (share.includeAudio && gcs && meeting.audioPath) {
        result.audioUrl = await gcs.getSignedUrl(meeting.audioPath, 60);
      }

      // Increment view count
      await firestore.incrementShareViewCount(shareId);

      return result;
    },

    /**
     * List active (non-expired) shares for a meeting, scoped to userId.
     */
    async listByMeeting(meetingId: string, userId: string): Promise<Share[]> {
      // Verify meeting ownership
      const meeting = await firestore.getMeeting(meetingId, userId);
      if (!meeting) return [];

      const shares = await firestore.listSharesByMeeting(meetingId, userId);

      // Filter out expired shares
      const now = new Date();
      return shares.filter((s) => !s.expiresAt || s.expiresAt >= now);
    },

    /**
     * Revoke a share link. Only the meeting owner can revoke.
     * Returns false if share not found or not owned by user.
     */
    async revoke(shareId: string, userId: string): Promise<boolean> {
      const share = await firestore.getShare(shareId);
      if (!share || share.userId !== userId) return false;

      await firestore.deleteShare(shareId, userId);
      return true;
    },
  };
}

export type ShareService = ReturnType<typeof createShareService>;
