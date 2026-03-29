/**
 * Meeting service unit tests — T-028.
 *
 * Tests meeting CRUD service layer with mocked Firestore adapter.
 * Verifies userId scoping, pagination, search token generation,
 * and cascading delete.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMeetingService, type MeetingService } from '../../src/services/meeting.js';
import type { FirestoreAdapter } from '../../src/types/adapters.js';
import type { Meeting, MeetingNote, TranscriptSegment, Speaker } from '../../src/types/domain.js';

// ── Mock factory ────────────────────────────────────────────────────

function mockFirestore(): FirestoreAdapter {
  return {
    getMeeting: vi.fn(),
    createMeeting: vi.fn(),
    updateMeeting: vi.fn(),
    deleteMeeting: vi.fn(),
    listMeetings: vi.fn(),
    getSegments: vi.fn(),
    batchWriteSegments: vi.fn(),
    getSpeakers: vi.fn(),
    updateSpeaker: vi.fn(),
    getNotes: vi.fn(),
    getNote: vi.fn(),
    getLatestNote: vi.fn(),
    createNote: vi.fn(),
    updateNote: vi.fn(),
    getTemplate: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
    listTemplates: vi.fn(),
    getAction: vi.fn(),
    createAction: vi.fn(),
    updateAction: vi.fn(),
    deleteAction: vi.fn(),
    listActions: vi.fn(),
    getShare: vi.fn(),
    createShare: vi.fn(),
    deleteShare: vi.fn(),
    listSharesByMeeting: vi.fn(),
    incrementShareViewCount: vi.fn(),
    storeEmbeddings: vi.fn(),
    deleteEmbeddingsByMeeting: vi.fn(),
    vectorSearch: vi.fn(),
    searchMeetings: vi.fn(),
    searchActions: vi.fn(),
    getUser: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    deleteUser: vi.fn(),
    healthCheck: vi.fn(),
    deleteAllUserData: vi.fn(),
  };
}

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'meeting-1',
    userId: 'user-1',
    title: 'Test Meeting',
    status: 'ready',
    attendees: [{ name: 'Alice', email: 'alice@test.com' }],
    tags: ['dev'],
    isStarred: false,
    latestNoteVersion: 0,
    searchTokens: ['test', 'meeting', 'alice'],
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('MeetingService', () => {
  let firestore: FirestoreAdapter;
  let service: MeetingService;

  beforeEach(() => {
    firestore = mockFirestore();
    service = createMeetingService({ firestore });
  });

  describe('create', () => {
    it('creates a meeting with generated search tokens', async () => {
      vi.mocked(firestore.createMeeting).mockResolvedValue(undefined);

      const result = await service.create({
        userId: 'user-1',
        title: 'Sprint Planning',
        attendees: [{ name: 'Bob Smith' }],
        tags: ['agile'],
      });

      expect(result.userId).toBe('user-1');
      expect(result.title).toBe('Sprint Planning');
      expect(result.status).toBe('ready');
      expect(result.isStarred).toBe(false);
      expect(result.latestNoteVersion).toBe(0);
      expect(result.searchTokens).toContain('sprint');
      expect(result.searchTokens).toContain('planning');
      expect(result.searchTokens).toContain('bob');
      expect(result.searchTokens).toContain('smith');
      expect(result.id).toBeDefined();
      expect(firestore.createMeeting).toHaveBeenCalledWith(result);
    });

    it('defaults attendees and tags to empty arrays', async () => {
      vi.mocked(firestore.createMeeting).mockResolvedValue(undefined);

      const result = await service.create({
        userId: 'user-1',
        title: 'Quick Chat',
      });

      expect(result.attendees).toEqual([]);
      expect(result.tags).toEqual([]);
    });

    it('includes calendarEventId when provided', async () => {
      vi.mocked(firestore.createMeeting).mockResolvedValue(undefined);

      const result = await service.create({
        userId: 'user-1',
        title: 'Calendar Meeting',
        calendarEventId: 'cal-123',
      });

      expect(result.calendarEventId).toBe('cal-123');
    });

    it('deduplicates search tokens', async () => {
      vi.mocked(firestore.createMeeting).mockResolvedValue(undefined);

      const result = await service.create({
        userId: 'user-1',
        title: 'Test Test',
        attendees: [{ name: 'Test Person' }],
      });

      const testCount = result.searchTokens.filter((t) => t === 'test').length;
      expect(testCount).toBe(1);
    });
  });

  describe('list', () => {
    it('passes userId and options to firestore', async () => {
      vi.mocked(firestore.listMeetings).mockResolvedValue({
        meetings: [makeMeeting()],
        cursor: undefined,
      });

      const result = await service.list({
        userId: 'user-1',
        status: 'ready',
        isStarred: true,
        tag: 'dev',
        sortBy: 'createdAt',
        sortOrder: 'desc',
        limit: 10,
      });

      expect(firestore.listMeetings).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          status: 'ready',
          isStarred: true,
          tag: 'dev',
          sortBy: 'createdAt',
          sortOrder: 'desc',
          limit: 10,
        }),
      );
      expect(result.meetings).toHaveLength(1);
    });

    it('filters by dateFrom', async () => {
      const oldMeeting = makeMeeting({ createdAt: new Date('2024-01-01') });
      const newMeeting = makeMeeting({ id: 'm-2', createdAt: new Date('2025-06-01') });
      vi.mocked(firestore.listMeetings).mockResolvedValue({
        meetings: [oldMeeting, newMeeting],
      });

      const result = await service.list({
        userId: 'user-1',
        dateFrom: '2025-01-01',
      });

      expect(result.meetings).toHaveLength(1);
      expect(result.meetings[0].id).toBe('m-2');
    });

    it('filters by dateTo', async () => {
      const oldMeeting = makeMeeting({ createdAt: new Date('2024-01-01') });
      const newMeeting = makeMeeting({ id: 'm-2', createdAt: new Date('2025-06-01') });
      vi.mocked(firestore.listMeetings).mockResolvedValue({
        meetings: [oldMeeting, newMeeting],
      });

      const result = await service.list({
        userId: 'user-1',
        dateTo: '2025-01-01',
      });

      expect(result.meetings).toHaveLength(1);
      expect(result.meetings[0].id).toBe('meeting-1');
    });

    it('filters by attendee name', async () => {
      const m1 = makeMeeting({ attendees: [{ name: 'Alice' }] });
      const m2 = makeMeeting({ id: 'm-2', attendees: [{ name: 'Bob' }] });
      vi.mocked(firestore.listMeetings).mockResolvedValue({
        meetings: [m1, m2],
      });

      const result = await service.list({
        userId: 'user-1',
        attendee: 'alice',
      });

      expect(result.meetings).toHaveLength(1);
      expect(result.meetings[0].attendees[0].name).toBe('Alice');
    });

    it('filters by attendee email', async () => {
      const m1 = makeMeeting({ attendees: [{ name: 'Alice', email: 'alice@co.com' }] });
      const m2 = makeMeeting({ id: 'm-2', attendees: [{ name: 'Bob', email: 'bob@co.com' }] });
      vi.mocked(firestore.listMeetings).mockResolvedValue({
        meetings: [m1, m2],
      });

      const result = await service.list({
        userId: 'user-1',
        attendee: 'bob@co.com',
      });

      expect(result.meetings).toHaveLength(1);
    });

    it('returns hasMore and cursor from firestore', async () => {
      vi.mocked(firestore.listMeetings).mockResolvedValue({
        meetings: [makeMeeting()],
        cursor: 'next-page-token',
      });

      const result = await service.list({ userId: 'user-1' });

      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe('next-page-token');
    });

    it('returns hasMore false when no cursor', async () => {
      vi.mocked(firestore.listMeetings).mockResolvedValue({
        meetings: [makeMeeting()],
        cursor: undefined,
      });

      const result = await service.list({ userId: 'user-1' });

      expect(result.hasMore).toBe(false);
    });
  });

  describe('getById', () => {
    it('returns meeting with latest notes when available', async () => {
      const meeting = makeMeeting({ latestNoteVersion: 2 });
      const note: MeetingNote = {
        version: 2,
        templateId: 'tpl-1',
        sections: [{ heading: 'Summary', content: 'Test' }],
        isEdited: false,
        model: 'sonnet',
        inputTokens: 100,
        outputTokens: 50,
        generationLatencyMs: 1000,
        generatedAt: new Date(),
      };
      vi.mocked(firestore.getMeeting).mockResolvedValue(meeting);
      vi.mocked(firestore.getLatestNote).mockResolvedValue(note);

      const result = await service.getById('meeting-1', 'user-1');

      expect(result).not.toBeNull();
      expect(result!.latestNotes).toEqual(note);
      expect(firestore.getMeeting).toHaveBeenCalledWith('meeting-1', 'user-1');
      expect(firestore.getLatestNote).toHaveBeenCalledWith('meeting-1', 'user-1');
    });

    it('returns null when meeting not found (userId scoping)', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(null);

      const result = await service.getById('meeting-1', 'wrong-user');

      expect(result).toBeNull();
    });

    it('omits latestNotes when latestNoteVersion is 0', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting({ latestNoteVersion: 0 }));

      const result = await service.getById('meeting-1', 'user-1');

      expect(result!.latestNotes).toBeUndefined();
      expect(firestore.getLatestNote).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('updates meeting fields and regenerates search tokens on title change', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.updateMeeting).mockResolvedValue(undefined);

      const result = await service.update('meeting-1', 'user-1', {
        title: 'New Title',
      });

      expect(result).not.toBeNull();
      expect(result!.title).toBe('New Title');
      expect(result!.searchTokens).toContain('new');
      expect(result!.searchTokens).toContain('title');
      expect(firestore.updateMeeting).toHaveBeenCalledWith(
        'meeting-1',
        'user-1',
        expect.objectContaining({ title: 'New Title', searchTokens: expect.any(Array) }),
      );
    });

    it('regenerates search tokens on attendees change', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.updateMeeting).mockResolvedValue(undefined);

      const result = await service.update('meeting-1', 'user-1', {
        attendees: [{ name: 'Charlie Brown' }],
      });

      expect(result!.searchTokens).toContain('charlie');
      expect(result!.searchTokens).toContain('brown');
    });

    it('does not regenerate search tokens when only isStarred changes', async () => {
      const original = makeMeeting();
      vi.mocked(firestore.getMeeting).mockResolvedValue(original);
      vi.mocked(firestore.updateMeeting).mockResolvedValue(undefined);

      await service.update('meeting-1', 'user-1', { isStarred: true });

      expect(firestore.updateMeeting).toHaveBeenCalledWith(
        'meeting-1',
        'user-1',
        expect.not.objectContaining({ searchTokens: expect.anything() }),
      );
    });

    it('returns null when meeting not found', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(null);

      const result = await service.update('nonexistent', 'user-1', { title: 'X' });

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes meeting and returns true', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.deleteMeeting).mockResolvedValue(undefined);

      const result = await service.delete('meeting-1', 'user-1');

      expect(result).toBe(true);
      expect(firestore.deleteMeeting).toHaveBeenCalledWith('meeting-1', 'user-1');
    });

    it('returns false when meeting not found (userId scoping)', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(null);

      const result = await service.delete('meeting-1', 'wrong-user');

      expect(result).toBe(false);
      expect(firestore.deleteMeeting).not.toHaveBeenCalled();
    });
  });

  describe('getTranscript', () => {
    it('returns paginated segments for owned meeting', async () => {
      const segments: TranscriptSegment[] = Array.from({ length: 3 }, (_, i) => ({
        id: `seg-${i}`,
        speaker: 'Alice',
        speakerId: 'spk-1',
        text: `Segment ${i}`,
        startTime: i * 10,
        endTime: (i + 1) * 10,
        channel: 'system_audio' as const,
        isUserNote: false,
        searchTokens: [],
      }));

      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.getSegments).mockResolvedValue(segments);

      const result = await service.getTranscript('meeting-1', 'user-1', { limit: 2 });

      expect(result.segments).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe('seg-1');
    });

    it('returns empty segments when meeting not found', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(null);

      const result = await service.getTranscript('meeting-1', 'wrong-user');

      expect(result.segments).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it('applies cursor-based pagination', async () => {
      const segments: TranscriptSegment[] = Array.from({ length: 5 }, (_, i) => ({
        id: `seg-${i}`,
        speaker: 'Alice',
        speakerId: 'spk-1',
        text: `Segment ${i}`,
        startTime: i * 10,
        endTime: (i + 1) * 10,
        channel: 'system_audio' as const,
        isUserNote: false,
        searchTokens: [],
      }));

      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.getSegments).mockResolvedValue(segments);

      const result = await service.getTranscript('meeting-1', 'user-1', {
        cursor: 'seg-1',
        limit: 2,
      });

      expect(result.segments[0].id).toBe('seg-2');
      expect(result.segments).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    });
  });

  describe('getSpeakers', () => {
    it('returns speakers for owned meeting', async () => {
      const speakers: Speaker[] = [{ id: 'spk-1', label: 'Speaker 1' }];
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.getSpeakers).mockResolvedValue(speakers);

      const result = await service.getSpeakers('meeting-1', 'user-1');

      expect(result).toEqual(speakers);
    });

    it('returns empty array when meeting not found', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(null);

      const result = await service.getSpeakers('meeting-1', 'wrong-user');

      expect(result).toEqual([]);
    });
  });

  describe('updateSpeaker', () => {
    it('updates speaker and returns true', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.updateSpeaker).mockResolvedValue(undefined);

      const result = await service.updateSpeaker('meeting-1', 'spk-1', 'user-1', {
        resolvedName: 'Alice Jones',
      });

      expect(result).toBe(true);
      expect(firestore.updateSpeaker).toHaveBeenCalledWith('meeting-1', 'spk-1', 'user-1', {
        resolvedName: 'Alice Jones',
      });
    });

    it('returns false when meeting not found', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(null);

      const result = await service.updateSpeaker('meeting-1', 'spk-1', 'wrong-user', {
        resolvedName: 'X',
      });

      expect(result).toBe(false);
    });
  });

  describe('getNotes', () => {
    it('returns notes for owned meeting', async () => {
      const notes: MeetingNote[] = [
        {
          version: 1,
          templateId: 'tpl-1',
          sections: [],
          isEdited: false,
          model: 'sonnet',
          inputTokens: 100,
          outputTokens: 50,
          generationLatencyMs: 500,
          generatedAt: new Date(),
        },
      ];
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.getNotes).mockResolvedValue(notes);

      const result = await service.getNotes('meeting-1', 'user-1');

      expect(result).toEqual(notes);
    });

    it('returns empty array when meeting not found', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(null);

      const result = await service.getNotes('meeting-1', 'wrong-user');

      expect(result).toEqual([]);
    });
  });

  describe('getLatestNote', () => {
    it('returns latest note for owned meeting', async () => {
      const note: MeetingNote = {
        version: 3,
        templateId: 'tpl-1',
        sections: [{ heading: 'Summary', content: 'Notes' }],
        isEdited: false,
        model: 'sonnet',
        inputTokens: 200,
        outputTokens: 100,
        generationLatencyMs: 1200,
        generatedAt: new Date(),
      };
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.getLatestNote).mockResolvedValue(note);

      const result = await service.getLatestNote('meeting-1', 'user-1');

      expect(result).toEqual(note);
    });

    it('returns null when meeting not found', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(null);

      const result = await service.getLatestNote('meeting-1', 'wrong-user');

      expect(result).toBeNull();
    });
  });

  describe('updateNote', () => {
    it('updates sections and sets isEdited flag', async () => {
      const existing: MeetingNote = {
        version: 1,
        templateId: 'tpl-1',
        sections: [{ heading: 'Summary', content: 'Old' }],
        isEdited: false,
        model: 'sonnet',
        inputTokens: 100,
        outputTokens: 50,
        generationLatencyMs: 500,
        generatedAt: new Date(),
      };
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.getNote).mockResolvedValue(existing);
      vi.mocked(firestore.updateNote).mockResolvedValue(undefined);

      const newSections = [{ heading: 'Summary', content: 'Updated content' }];
      const result = await service.updateNote('meeting-1', 1, 'user-1', newSections);

      expect(result).not.toBeNull();
      expect(result!.sections).toEqual(newSections);
      expect(result!.isEdited).toBe(true);
      expect(firestore.updateNote).toHaveBeenCalledWith('meeting-1', 1, 'user-1', {
        sections: newSections,
        isEdited: true,
      });
    });

    it('returns null when meeting not found', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(null);

      const result = await service.updateNote('meeting-1', 1, 'wrong-user', []);

      expect(result).toBeNull();
    });

    it('returns null when note version not found', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.getNote).mockResolvedValue(null);

      const result = await service.updateNote('meeting-1', 99, 'user-1', []);

      expect(result).toBeNull();
    });
  });
});
