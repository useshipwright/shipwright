/**
 * User notes service unit tests — T-028.
 *
 * Tests user notes ingestion service with mocked Firestore adapter.
 * Verifies userId/meetingId scoping, isUserNote flag, and ordering.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUserNotesService, type UserNotesService } from '../../src/services/user-notes.js';
import type { FirestoreAdapter } from '../../src/types/adapters.js';
import type { Meeting, TranscriptSegment } from '../../src/types/domain.js';

// ── Mock factory ────────────────────────────────────────────────────

function mockFirestore(): Pick<
  FirestoreAdapter,
  'getMeeting' | 'batchWriteSegments' | 'getSegments'
> {
  return {
    getMeeting: vi.fn(),
    batchWriteSegments: vi.fn(),
    getSegments: vi.fn(),
  };
}

function makeMeeting(): Meeting {
  return {
    id: 'meeting-1',
    userId: 'user-1',
    title: 'Test Meeting',
    status: 'ready',
    attendees: [],
    tags: [],
    isStarred: false,
    latestNoteVersion: 0,
    searchTokens: [],
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  };
}

function makeSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: 'seg-1',
    speaker: 'Alice',
    speakerId: 'spk-1',
    text: 'Hello world',
    startTime: 10,
    endTime: 20,
    channel: 'system_audio',
    isUserNote: false,
    searchTokens: ['hello', 'world'],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('UserNotesService', () => {
  let firestore: ReturnType<typeof mockFirestore>;
  let service: UserNotesService;

  beforeEach(() => {
    firestore = mockFirestore();
    service = createUserNotesService({ firestore: firestore as unknown as FirestoreAdapter });
  });

  describe('create', () => {
    it('creates a user note with isUserNote=true', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.batchWriteSegments).mockResolvedValue(undefined);

      const result = await service.create({
        userId: 'user-1',
        meetingId: 'meeting-1',
        text: 'Important point about the project',
      });

      expect(result).not.toBeNull();
      expect(result!.isUserNote).toBe(true);
      expect(result!.speaker).toBe('User');
      expect(result!.speakerId).toBe('user');
      expect(result!.channel).toBe('user_input');
      expect(result!.text).toBe('Important point about the project');
      expect(result!.id).toBeDefined();
    });

    it('generates search tokens from text', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.batchWriteSegments).mockResolvedValue(undefined);

      const result = await service.create({
        userId: 'user-1',
        meetingId: 'meeting-1',
        text: 'Budget discussion quarterly',
      });

      expect(result!.searchTokens).toContain('budget');
      expect(result!.searchTokens).toContain('discussion');
      expect(result!.searchTokens).toContain('quarterly');
    });

    it('defaults timestamp to 0 when not provided', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.batchWriteSegments).mockResolvedValue(undefined);

      const result = await service.create({
        userId: 'user-1',
        meetingId: 'meeting-1',
        text: 'Note',
      });

      expect(result!.startTime).toBe(0);
      expect(result!.endTime).toBe(0);
    });

    it('uses provided timestamp', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.batchWriteSegments).mockResolvedValue(undefined);

      const result = await service.create({
        userId: 'user-1',
        meetingId: 'meeting-1',
        text: 'Note',
        timestamp: 42.5,
      });

      expect(result!.startTime).toBe(42.5);
      expect(result!.endTime).toBe(42.5);
    });

    it('returns null when meeting not found (userId scoping)', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(null);

      const result = await service.create({
        userId: 'wrong-user',
        meetingId: 'meeting-1',
        text: 'Note',
      });

      expect(result).toBeNull();
      expect(firestore.batchWriteSegments).not.toHaveBeenCalled();
    });

    it('calls batchWriteSegments with the created segment', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.batchWriteSegments).mockResolvedValue(undefined);

      const result = await service.create({
        userId: 'user-1',
        meetingId: 'meeting-1',
        text: 'A note',
      });

      expect(firestore.batchWriteSegments).toHaveBeenCalledWith('meeting-1', [result]);
    });

    it('verifies meeting ownership via getMeeting(meetingId, userId)', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(null);

      await service.create({
        userId: 'user-1',
        meetingId: 'meeting-1',
        text: 'Note',
      });

      expect(firestore.getMeeting).toHaveBeenCalledWith('meeting-1', 'user-1');
    });
  });

  describe('list', () => {
    it('returns only user notes sorted by startTime', async () => {
      const segments = [
        makeSegment({ id: 's-1', startTime: 30, isUserNote: false }),
        makeSegment({ id: 's-2', startTime: 10, isUserNote: true, speaker: 'User' }),
        makeSegment({ id: 's-3', startTime: 20, isUserNote: true, speaker: 'User' }),
      ];

      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.getSegments).mockResolvedValue(segments);

      const result = await service.list('meeting-1', 'user-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('s-2'); // startTime 10
      expect(result[1].id).toBe('s-3'); // startTime 20
      expect(result.every((s) => s.isUserNote)).toBe(true);
    });

    it('returns empty array when meeting not found (userId scoping)', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(null);

      const result = await service.list('meeting-1', 'wrong-user');

      expect(result).toEqual([]);
    });

    it('returns empty array when no user notes exist', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.getSegments).mockResolvedValue([
        makeSegment({ isUserNote: false }),
      ]);

      const result = await service.list('meeting-1', 'user-1');

      expect(result).toEqual([]);
    });

    it('verifies meeting ownership via getMeeting', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(null);

      await service.list('meeting-1', 'user-1');

      expect(firestore.getMeeting).toHaveBeenCalledWith('meeting-1', 'user-1');
    });
  });
});
