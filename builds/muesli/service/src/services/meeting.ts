/**
 * Meeting service layer — business logic for meeting CRUD, transcript,
 * speaker management, and versioned notes access.
 *
 * All operations are scoped by userId for tenant isolation (IDOR prevention).
 */

import type { FirestoreAdapter, ListMeetingsOptions } from '../types/adapters.js';
import type {
  Meeting,
  TranscriptSegment,
  Speaker,
  MeetingNote,
  Attendee,
  MeetingStatus,
} from '../types/domain.js';

// ── Token generation ────────────────────────────────────────────────

/**
 * Generate lowercase search tokens from title and attendee names.
 * Used for Firestore array-contains full-text search.
 */
function generateSearchTokens(title: string, attendees: Attendee[]): string[] {
  const parts: string[] = [];

  // Tokenize title
  parts.push(...title.toLowerCase().split(/\s+/).filter(Boolean));

  // Tokenize attendee names
  for (const a of attendees) {
    parts.push(...a.name.toLowerCase().split(/\s+/).filter(Boolean));
  }

  // Deduplicate
  return [...new Set(parts)];
}

// ── Service interface ───────────────────────────────────────────────

export interface MeetingServiceDeps {
  firestore: FirestoreAdapter;
}

export interface ListMeetingsParams {
  userId: string;
  cursor?: string;
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
  attendee?: string;
  tag?: string;
  status?: MeetingStatus;
  isStarred?: boolean;
  sortBy?: 'createdAt' | 'startedAt' | 'title';
  sortOrder?: 'asc' | 'desc';
}

export interface CreateMeetingParams {
  userId: string;
  title: string;
  calendarEventId?: string;
  attendees?: Attendee[];
  tags?: string[];
}

export interface UpdateMeetingParams {
  title?: string;
  attendees?: Attendee[];
  tags?: string[];
  isStarred?: boolean;
}

export interface MeetingWithLatestNotes extends Meeting {
  latestNotes?: MeetingNote;
}

// ── Service factory ─────────────────────────────────────────────────

export function createMeetingService(deps: MeetingServiceDeps) {
  const { firestore } = deps;

  return {
    /**
     * Create a new meeting with generated search tokens.
     */
    async create(params: CreateMeetingParams): Promise<Meeting> {
      const now = new Date();
      const attendees = params.attendees ?? [];
      const tags = params.tags ?? [];

      const meeting: Meeting = {
        id: generateId(),
        userId: params.userId,
        title: params.title,
        status: 'ready',
        attendees,
        tags,
        isStarred: false,
        ...(params.calendarEventId ? { calendarEventId: params.calendarEventId } : {}),
        latestNoteVersion: 0,
        searchTokens: generateSearchTokens(params.title, attendees),
        createdAt: now,
        updatedAt: now,
      };

      await firestore.createMeeting(meeting);
      return meeting;
    },

    /**
     * List meetings with pagination and filters, scoped by userId.
     */
    async list(params: ListMeetingsParams): Promise<{
      meetings: Meeting[];
      cursor?: string;
      hasMore: boolean;
    }> {
      const options: ListMeetingsOptions = {
        userId: params.userId,
        status: params.status,
        isStarred: params.isStarred,
        tag: params.tag,
        sortBy: params.sortBy,
        sortOrder: params.sortOrder,
        cursor: params.cursor,
        limit: params.limit,
      };

      const result = await firestore.listMeetings(options);

      // Post-filter by dateFrom/dateTo if provided
      let filtered = result.meetings;
      if (params.dateFrom) {
        const from = new Date(params.dateFrom);
        filtered = filtered.filter((m) => m.createdAt >= from);
      }
      if (params.dateTo) {
        const to = new Date(params.dateTo);
        filtered = filtered.filter((m) => m.createdAt <= to);
      }
      if (params.attendee) {
        const needle = params.attendee.toLowerCase();
        filtered = filtered.filter((m) =>
          m.attendees.some(
            (a) =>
              a.name.toLowerCase().includes(needle) ||
              (a.email && a.email.toLowerCase().includes(needle)),
          ),
        );
      }

      return {
        meetings: filtered,
        cursor: result.cursor,
        hasMore: !!result.cursor,
      };
    },

    /**
     * Get meeting by ID with latest notes summary.
     */
    async getById(
      meetingId: string,
      userId: string,
    ): Promise<MeetingWithLatestNotes | null> {
      const meeting = await firestore.getMeeting(meetingId, userId);
      if (!meeting) return null;

      let latestNotes: MeetingNote | null = null;
      if (meeting.latestNoteVersion > 0) {
        latestNotes = await firestore.getLatestNote(meetingId, userId);
      }

      return {
        ...meeting,
        latestNotes: latestNotes ?? undefined,
      };
    },

    /**
     * Update meeting fields. Regenerates search tokens when title or attendees change.
     */
    async update(
      meetingId: string,
      userId: string,
      params: UpdateMeetingParams,
    ): Promise<Meeting | null> {
      const existing = await firestore.getMeeting(meetingId, userId);
      if (!existing) return null;

      const updates: Partial<Meeting> = {
        ...params,
        updatedAt: new Date(),
      };

      // Regenerate search tokens if title or attendees changed
      if (params.title !== undefined || params.attendees !== undefined) {
        const title = params.title ?? existing.title;
        const attendees = params.attendees ?? existing.attendees;
        updates.searchTokens = generateSearchTokens(title, attendees);
      }

      await firestore.updateMeeting(meetingId, userId, updates);

      return {
        ...existing,
        ...updates,
      };
    },

    /**
     * Delete meeting and all subcollections.
     */
    async delete(meetingId: string, userId: string): Promise<boolean> {
      const existing = await firestore.getMeeting(meetingId, userId);
      if (!existing) return false;

      await firestore.deleteMeeting(meetingId, userId);
      return true;
    },

    /**
     * Get transcript segments ordered by time.
     */
    async getTranscript(
      meetingId: string,
      userId: string,
      options?: { cursor?: string; limit?: number },
    ): Promise<{ segments: TranscriptSegment[]; cursor?: string; hasMore: boolean }> {
      const meeting = await firestore.getMeeting(meetingId, userId);
      if (!meeting) return { segments: [], hasMore: false };

      const segments = await firestore.getSegments(meetingId, userId);

      // Apply cursor-based pagination
      const limit = options?.limit ?? 500;
      let startIndex = 0;
      if (options?.cursor) {
        const cursorIdx = segments.findIndex((s) => s.id === options.cursor);
        if (cursorIdx >= 0) startIndex = cursorIdx + 1;
      }

      const page = segments.slice(startIndex, startIndex + limit + 1);
      const hasMore = page.length > limit;
      const result = hasMore ? page.slice(0, limit) : page;
      const cursor = hasMore ? result[result.length - 1].id : undefined;

      return { segments: result, cursor, hasMore };
    },

    /**
     * Get speakers for a meeting.
     */
    async getSpeakers(meetingId: string, userId: string): Promise<Speaker[]> {
      const meeting = await firestore.getMeeting(meetingId, userId);
      if (!meeting) return [];
      return firestore.getSpeakers(meetingId, userId);
    },

    /**
     * Rename or resolve a speaker.
     */
    async updateSpeaker(
      meetingId: string,
      speakerId: string,
      userId: string,
      data: { resolvedName?: string; resolvedEmail?: string },
    ): Promise<boolean> {
      const meeting = await firestore.getMeeting(meetingId, userId);
      if (!meeting) return false;

      await firestore.updateSpeaker(meetingId, speakerId, userId, data);
      return true;
    },

    /**
     * List all note versions for a meeting.
     */
    async getNotes(meetingId: string, userId: string): Promise<MeetingNote[]> {
      const meeting = await firestore.getMeeting(meetingId, userId);
      if (!meeting) return [];
      return firestore.getNotes(meetingId, userId);
    },

    /**
     * Get latest note version.
     */
    async getLatestNote(
      meetingId: string,
      userId: string,
    ): Promise<MeetingNote | null> {
      const meeting = await firestore.getMeeting(meetingId, userId);
      if (!meeting) return null;
      return firestore.getLatestNote(meetingId, userId);
    },

    /**
     * Get a specific note version.
     */
    async getNote(
      meetingId: string,
      version: number,
      userId: string,
    ): Promise<MeetingNote | null> {
      const meeting = await firestore.getMeeting(meetingId, userId);
      if (!meeting) return null;
      return firestore.getNote(meetingId, version, userId);
    },

    /**
     * Update note sections and set isEdited flag.
     */
    async updateNote(
      meetingId: string,
      version: number,
      userId: string,
      sections: { heading: string; content: string }[],
    ): Promise<MeetingNote | null> {
      const meeting = await firestore.getMeeting(meetingId, userId);
      if (!meeting) return null;

      const existing = await firestore.getNote(meetingId, version, userId);
      if (!existing) return null;

      await firestore.updateNote(meetingId, version, userId, {
        sections,
        isEdited: true,
      });

      return {
        ...existing,
        sections,
        isEdited: true,
      };
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID();
}

export type MeetingService = ReturnType<typeof createMeetingService>;
