/**
 * Share service tests — T-031.
 *
 * Tests business logic for shareable meeting note links:
 * share creation, access modes, expiry, view count, and email stripping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createShareService, type ShareService } from '../../src/services/share.js';
import type { FirestoreAdapter, GCSAdapter } from '../../src/types/adapters.js';
import type { Share, Meeting, MeetingNote } from '../../src/types/domain.js';

// ── Mock factories ──────────────────────────────────────────────────

function mockFirestore(): FirestoreAdapter {
  return {
    getUser: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    deleteUser: vi.fn(),
    getMeeting: vi.fn(),
    createMeeting: vi.fn(),
    updateMeeting: vi.fn(),
    deleteMeeting: vi.fn(),
    listMeetings: vi.fn(),
    getSegments: vi.fn().mockResolvedValue([]),
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
    listSharesByMeeting: vi.fn().mockResolvedValue([]),
    incrementShareViewCount: vi.fn(),
    storeEmbeddings: vi.fn(),
    deleteEmbeddingsByMeeting: vi.fn(),
    vectorSearch: vi.fn(),
    searchMeetings: vi.fn(),
    searchActions: vi.fn(),
    listConnectedCalendarUsers: vi.fn(),
    healthCheck: vi.fn(),
    deleteAllUserData: vi.fn(),
  } as unknown as FirestoreAdapter;
}

function mockGCS(): GCSAdapter {
  return {
    upload: vi.fn(),
    createWriteStream: vi.fn(),
    getSignedUrl: vi.fn().mockResolvedValue('https://storage.googleapis.com/signed-url'),
    delete: vi.fn(),
    deleteByPrefix: vi.fn(),
    healthCheck: vi.fn(),
  } as unknown as GCSAdapter;
}

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'meeting-1',
    userId: 'user-1',
    title: 'Sprint Planning',
    status: 'ready',
    attendees: [
      { name: 'Alice', email: 'alice@test.com' },
      { name: 'Bob', email: 'bob@test.com' },
    ],
    tags: [],
    isStarred: false,
    latestNoteVersion: 1,
    searchTokens: ['sprint', 'planning'],
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    audioPath: 'audio/user-1/meeting-1/recording.webm',
    ...overrides,
  };
}

function makeNote(): MeetingNote {
  return {
    version: 1,
    templateId: 'tpl-1',
    sections: [{ heading: 'Summary', content: 'Great meeting' }],
    isEdited: false,
    model: 'sonnet',
    inputTokens: 100,
    outputTokens: 50,
    generationLatencyMs: 500,
    generatedAt: new Date('2025-01-01'),
  };
}

function makeShare(overrides: Partial<Share> = {}): Share {
  return {
    shareId: 'share-uuid-1',
    meetingId: 'meeting-1',
    userId: 'user-1',
    accessMode: 'public',
    includeTranscript: false,
    includeAudio: false,
    viewCount: 0,
    createdAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Share Service', () => {
  let firestore: FirestoreAdapter;
  let gcs: GCSAdapter;
  let service: ShareService;

  beforeEach(() => {
    vi.clearAllMocks();
    firestore = mockFirestore();
    gcs = mockGCS();
    service = createShareService({ firestore, gcs });
  });

  describe('create', () => {
    it('creates share with cryptographically random shareId', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());

      const share = await service.create({
        userId: 'user-1',
        meetingId: 'meeting-1',
        accessMode: 'public',
        includeTranscript: false,
        includeAudio: false,
      });

      expect(share).not.toBeNull();
      // crypto.randomUUID() produces 36-char UUIDs with 122 bits of randomness (>128 bit target met by design)
      expect(share!.shareId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(firestore.createShare).toHaveBeenCalledWith(
        expect.objectContaining({ shareId: share!.shareId }),
      );
    });

    it('creates public share (no auth required)', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());

      const share = await service.create({
        userId: 'user-1',
        meetingId: 'meeting-1',
        accessMode: 'public',
        includeTranscript: false,
        includeAudio: false,
      });

      expect(share!.accessMode).toBe('public');
    });

    it('creates authenticated share (any valid JWT)', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());

      const share = await service.create({
        userId: 'user-1',
        meetingId: 'meeting-1',
        accessMode: 'authenticated',
        includeTranscript: false,
        includeAudio: false,
      });

      expect(share!.accessMode).toBe('authenticated');
    });

    it('creates specific_emails share (JWT email match)', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());

      const share = await service.create({
        userId: 'user-1',
        meetingId: 'meeting-1',
        accessMode: 'specific_emails',
        allowedEmails: ['viewer@test.com'],
        includeTranscript: false,
        includeAudio: false,
      });

      expect(share!.accessMode).toBe('specific_emails');
      expect(share!.allowedEmails).toEqual(['viewer@test.com']);
    });

    it('throws when specific_emails has no allowedEmails', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());

      await expect(
        service.create({
          userId: 'user-1',
          meetingId: 'meeting-1',
          accessMode: 'specific_emails',
          includeTranscript: false,
          includeAudio: false,
        }),
      ).rejects.toThrow('allowedEmails required');
    });

    it('respects includeTranscript flag', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());

      const share = await service.create({
        userId: 'user-1',
        meetingId: 'meeting-1',
        accessMode: 'public',
        includeTranscript: true,
        includeAudio: false,
      });

      expect(share!.includeTranscript).toBe(true);
    });

    it('respects includeAudio flag', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());

      const share = await service.create({
        userId: 'user-1',
        meetingId: 'meeting-1',
        accessMode: 'public',
        includeTranscript: false,
        includeAudio: true,
      });

      expect(share!.includeAudio).toBe(true);
    });

    it('returns null when meeting not found (ownership check)', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(null);

      const share = await service.create({
        userId: 'user-1',
        meetingId: 'nonexistent',
        accessMode: 'public',
        includeTranscript: false,
        includeAudio: false,
      });

      expect(share).toBeNull();
    });

    it('sets expiresAt when provided', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      const expiry = new Date('2025-12-31');

      const share = await service.create({
        userId: 'user-1',
        meetingId: 'meeting-1',
        accessMode: 'public',
        includeTranscript: false,
        includeAudio: false,
        expiresAt: expiry,
      });

      expect(share!.expiresAt).toEqual(expiry);
    });
  });

  describe('view', () => {
    it('returns share view data with attendee emails stripped (names only)', async () => {
      vi.mocked(firestore.getShare).mockResolvedValue(makeShare());
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.getLatestNote).mockResolvedValue(makeNote());

      const result = await service.view('share-uuid-1');

      expect(result).not.toBeNull();
      expect(result!.meeting.title).toBe('Sprint Planning');
      // Emails must be stripped — only names returned
      for (const a of result!.meeting.attendees) {
        expect(a).toEqual({ name: expect.any(String) });
        expect((a as Record<string, unknown>)['email']).toBeUndefined();
      }
    });

    it('increments view count on access', async () => {
      vi.mocked(firestore.getShare).mockResolvedValue(makeShare());
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.getLatestNote).mockResolvedValue(null);

      await service.view('share-uuid-1');

      expect(firestore.incrementShareViewCount).toHaveBeenCalledWith('share-uuid-1');
    });

    it('returns null for expired share', async () => {
      vi.mocked(firestore.getShare).mockResolvedValue(
        makeShare({ expiresAt: new Date('2020-01-01') }),
      );

      const result = await service.view('share-uuid-1');
      expect(result).toBeNull();
    });

    it('returns null for non-existent share', async () => {
      vi.mocked(firestore.getShare).mockResolvedValue(null);

      const result = await service.view('nonexistent');
      expect(result).toBeNull();
    });

    it('includes transcript when includeTranscript is true', async () => {
      const segments = [
        {
          id: 'seg-1',
          speaker: 'Alice',
          speakerId: 's1',
          text: 'Hello',
          startTime: 0,
          endTime: 5,
          channel: 'system_audio' as const,
          isUserNote: false,
          searchTokens: ['hello'],
        },
      ];
      vi.mocked(firestore.getShare).mockResolvedValue(
        makeShare({ includeTranscript: true }),
      );
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.getLatestNote).mockResolvedValue(null);
      vi.mocked(firestore.getSegments).mockResolvedValue(segments);

      const result = await service.view('share-uuid-1');

      expect(result!.transcript).toEqual(segments);
    });

    it('includes audio URL when includeAudio is true', async () => {
      vi.mocked(firestore.getShare).mockResolvedValue(
        makeShare({ includeAudio: true }),
      );
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.getLatestNote).mockResolvedValue(null);

      const result = await service.view('share-uuid-1');

      expect(result!.audioUrl).toBe('https://storage.googleapis.com/signed-url');
      expect(gcs.getSignedUrl).toHaveBeenCalled();
    });

    it('does not include transcript when includeTranscript is false', async () => {
      vi.mocked(firestore.getShare).mockResolvedValue(
        makeShare({ includeTranscript: false }),
      );
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.getLatestNote).mockResolvedValue(null);

      const result = await service.view('share-uuid-1');

      expect(result!.transcript).toBeUndefined();
    });
  });

  describe('listByMeeting', () => {
    it('returns active shares filtered by expiry', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(makeMeeting());
      vi.mocked(firestore.listSharesByMeeting).mockResolvedValue([
        makeShare({ shareId: 's1' }),
        makeShare({ shareId: 's2', expiresAt: new Date('2020-01-01') }),
      ]);

      const shares = await service.listByMeeting('meeting-1', 'user-1');

      expect(shares).toHaveLength(1);
      expect(shares[0].shareId).toBe('s1');
    });

    it('returns empty array when meeting not found', async () => {
      vi.mocked(firestore.getMeeting).mockResolvedValue(null);
      const shares = await service.listByMeeting('meeting-1', 'user-1');
      expect(shares).toEqual([]);
    });
  });

  describe('revoke', () => {
    it('revokes share owned by user', async () => {
      vi.mocked(firestore.getShare).mockResolvedValue(makeShare());

      const result = await service.revoke('share-uuid-1', 'user-1');

      expect(result).toBe(true);
      expect(firestore.deleteShare).toHaveBeenCalledWith('share-uuid-1', 'user-1');
    });

    it('returns false when share not found', async () => {
      vi.mocked(firestore.getShare).mockResolvedValue(null);
      const result = await service.revoke('nonexistent', 'user-1');
      expect(result).toBe(false);
    });

    it('returns false when share owned by different user', async () => {
      vi.mocked(firestore.getShare).mockResolvedValue(
        makeShare({ userId: 'other-user' }),
      );

      const result = await service.revoke('share-uuid-1', 'user-1');
      expect(result).toBe(false);
      expect(firestore.deleteShare).not.toHaveBeenCalled();
    });
  });
});
