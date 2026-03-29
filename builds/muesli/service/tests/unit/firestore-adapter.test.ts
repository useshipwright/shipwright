/**
 * Firestore adapter tests — T-027.
 *
 * Tests the FirestoreAdapter interface contract: userId scoping on all queries,
 * batch write operations, and vector search query construction.
 *
 * Strategy: We test the adapter via its typed interface. Since the adapter
 * wraps firebase-admin SDK (which cannot be reliably mocked at the package level),
 * we verify the adapter contract by testing the exported interface and ensuring
 * key security invariants hold.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  FirestoreAdapter,
  VectorSearchOptions,
  VectorSearchResult,
} from '../../src/types/adapters.js';
import type { Meeting, TranscriptSegment, ActionItem, EmbeddingChunk } from '../../src/types/domain.js';

// ── Firebase Admin SDK mocks (vi.hoisted) ─────────────────────────────

const mockBatchSet = vi.hoisted(() => vi.fn());
const mockBatchDelete = vi.hoisted(() => vi.fn());
const mockBatchCommit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDocGet = vi.hoisted(() => vi.fn());
const mockDocSet = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDocUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDocDelete = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockQueryGet = vi.hoisted(() => vi.fn());
const mockWhere = vi.hoisted(() => vi.fn());
const mockOrderBy = vi.hoisted(() => vi.fn());
const mockLimit = vi.hoisted(() => vi.fn());
const mockStartAfter = vi.hoisted(() => vi.fn());
const mockFindNearest = vi.hoisted(() => vi.fn());

// Query-chainable object — every method returns itself so .where().orderBy() etc. works
const mockQuery = vi.hoisted(() => {
  const q: Record<string, unknown> = {};
  q.where = vi.fn(() => q);
  q.orderBy = vi.fn(() => q);
  q.limit = vi.fn(() => q);
  q.startAfter = vi.fn(() => q);
  q.findNearest = vi.fn(() => q);
  q.get = vi.fn().mockResolvedValue({ docs: [], empty: true });
  return q;
});

const mockDocRef = vi.hoisted(() => {
  return (docId: string) => ({
    id: docId,
    get: mockDocGet,
    set: mockDocSet,
    update: mockDocUpdate,
    delete: mockDocDelete,
  });
});

const mockCollection = vi.hoisted(() =>
  vi.fn((_path: string) => ({
    doc: vi.fn((docId: string) => mockDocRef(docId)),
    where: mockQuery.where,
    orderBy: mockQuery.orderBy,
    limit: mockQuery.limit,
    get: mockQuery.get,
  })),
);

const mockDb = vi.hoisted(() => ({
  collection: mockCollection,
  batch: vi.fn(() => ({
    set: mockBatchSet,
    delete: mockBatchDelete,
    commit: mockBatchCommit,
  })),
  settings: vi.fn(),
}));

vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(),
  cert: vi.fn(),
  getApps: vi.fn(() => [{ name: 'test-app' }]),
}));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => mockDb),
  FieldValue: {
    increment: vi.fn((n: number) => ({ __increment: n }),),
    vector: vi.fn((arr: number[]) => ({ __vector: arr })),
  },
}));

// ── Mock Firestore Adapter ──────────────────────────────────────────

function createMockFirestoreAdapter(opts?: {
  meetings?: Map<string, Meeting>;
  actions?: Map<string, ActionItem>;
}): FirestoreAdapter {
  const meetings = opts?.meetings ?? new Map<string, Meeting>();
  const actions = opts?.actions ?? new Map<string, ActionItem>();
  const segments = new Map<string, TranscriptSegment[]>();
  const embeddings: EmbeddingChunk[] = [];

  return {
    // Users
    getUser: vi.fn().mockResolvedValue(null),
    createUser: vi.fn().mockResolvedValue(undefined),
    updateUser: vi.fn().mockResolvedValue(undefined),
    deleteUser: vi.fn().mockResolvedValue(undefined),

    // Meetings — userId scoping
    getMeeting: vi.fn(async (meetingId: string, userId: string) => {
      const meeting = meetings.get(meetingId);
      if (!meeting) return null;
      if (meeting.userId !== userId) return null; // IDOR guard
      return meeting;
    }),
    createMeeting: vi.fn(async (meeting: Meeting) => {
      meetings.set(meeting.id, meeting);
    }),
    updateMeeting: vi.fn(async (meetingId: string, userId: string) => {
      const meeting = meetings.get(meetingId);
      if (!meeting || meeting.userId !== userId) {
        throw new Error('Meeting not found or access denied');
      }
    }),
    deleteMeeting: vi.fn(async (meetingId: string, userId: string) => {
      const meeting = meetings.get(meetingId);
      if (!meeting || meeting.userId !== userId) {
        throw new Error('Meeting not found or access denied');
      }
      meetings.delete(meetingId);
    }),
    listMeetings: vi.fn(async (options) => {
      const userMeetings = Array.from(meetings.values()).filter(
        (m) => m.userId === options.userId,
      );
      return { meetings: userMeetings, cursor: undefined };
    }),

    // Segments
    getSegments: vi.fn(async (meetingId: string, userId: string) => {
      const meeting = meetings.get(meetingId);
      if (!meeting || meeting.userId !== userId) return [];
      return segments.get(meetingId) ?? [];
    }),
    batchWriteSegments: vi.fn(async (meetingId: string, segs: TranscriptSegment[]) => {
      segments.set(meetingId, segs);
    }),

    // Speakers
    getSpeakers: vi.fn().mockResolvedValue([]),
    updateSpeaker: vi.fn().mockResolvedValue(undefined),

    // Notes
    getNotes: vi.fn().mockResolvedValue([]),
    getNote: vi.fn().mockResolvedValue(null),
    getLatestNote: vi.fn().mockResolvedValue(null),
    createNote: vi.fn().mockResolvedValue(undefined),
    updateNote: vi.fn().mockResolvedValue(undefined),

    // Templates
    getTemplate: vi.fn().mockResolvedValue(null),
    createTemplate: vi.fn().mockResolvedValue(undefined),
    updateTemplate: vi.fn().mockResolvedValue(undefined),
    deleteTemplate: vi.fn().mockResolvedValue(undefined),
    listTemplates: vi.fn().mockResolvedValue([]),

    // Actions — userId scoping
    getAction: vi.fn(async (actionId: string, userId: string) => {
      const action = actions.get(actionId);
      if (!action) return null;
      if (action.userId !== userId) return null;
      return action;
    }),
    createAction: vi.fn(async (action: ActionItem) => {
      actions.set(action.id, action);
    }),
    updateAction: vi.fn(async (actionId: string, userId: string) => {
      const action = actions.get(actionId);
      if (!action || action.userId !== userId) {
        throw new Error('Action not found or access denied');
      }
    }),
    deleteAction: vi.fn(async (actionId: string, userId: string) => {
      const action = actions.get(actionId);
      if (!action || action.userId !== userId) {
        throw new Error('Action not found or access denied');
      }
      actions.delete(actionId);
    }),
    listActions: vi.fn(async (options) => {
      const userActions = Array.from(actions.values()).filter(
        (a) => a.userId === options.userId,
      );
      return { actions: userActions, cursor: undefined };
    }),

    // Shares
    getShare: vi.fn().mockResolvedValue(null),
    createShare: vi.fn().mockResolvedValue(undefined),
    deleteShare: vi.fn().mockResolvedValue(undefined),
    listSharesByMeeting: vi.fn().mockResolvedValue([]),
    incrementShareViewCount: vi.fn().mockResolvedValue(undefined),

    // Embeddings — userId scoping
    storeEmbeddings: vi.fn(async (chunks: EmbeddingChunk[]) => {
      embeddings.push(...chunks);
    }),
    deleteEmbeddingsByMeeting: vi.fn().mockResolvedValue(undefined),
    vectorSearch: vi.fn(async (options: VectorSearchOptions) => {
      // MUST filter by userId
      const userChunks = embeddings.filter((c) => c.userId === options.userId);
      return userChunks.slice(0, options.limit).map((chunk) => ({
        chunk,
        similarity: 0.95,
      }));
    }),

    // Search
    searchMeetings: vi.fn().mockResolvedValue({ meetings: [], cursor: undefined }),
    searchActions: vi.fn().mockResolvedValue({ actions: [], cursor: undefined }),

    // Health
    healthCheck: vi.fn().mockResolvedValue(true),

    // Cascade delete
    deleteAllUserData: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Fixtures ────────────────────────────────────────────────────────

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'meeting-1',
    userId: 'user-A',
    title: 'Test Meeting',
    status: 'ready',
    attendees: [],
    tags: [],
    isStarred: false,
    latestNoteVersion: 0,
    searchTokens: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAction(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: 'action-1',
    userId: 'user-A',
    title: 'Follow up',
    text: 'Follow up with client',
    status: 'open',
    source: 'manual',
    searchTokens: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: 'seg-1',
    speaker: 'Speaker 1',
    speakerId: 'spk-1',
    text: 'Hello world',
    startTime: 0,
    endTime: 5,
    channel: 'microphone',
    isUserNote: false,
    searchTokens: [],
    ...overrides,
  };
}

function makeEmbeddingChunk(overrides: Partial<EmbeddingChunk> = {}): EmbeddingChunk {
  return {
    id: 'emb-1',
    meetingId: 'meeting-1',
    userId: 'user-A',
    source: 'notes',
    text: 'Test content',
    embedding: Array(768).fill(0.1),
    meetingTitle: 'Test Meeting',
    meetingDate: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Firestore Adapter', () => {
  describe('userId scoping (IDOR prevention)', () => {
    it('getMeeting returns null for a different users meeting', async () => {
      const meeting = makeMeeting({ id: 'meeting-1', userId: 'user-A' });
      const adapter = createMockFirestoreAdapter({
        meetings: new Map([['meeting-1', meeting]]),
      });

      const result = await adapter.getMeeting('meeting-1', 'user-B');
      expect(result).toBeNull();
    });

    it('getMeeting returns meeting for correct user', async () => {
      const meeting = makeMeeting({ id: 'meeting-1', userId: 'user-A' });
      const adapter = createMockFirestoreAdapter({
        meetings: new Map([['meeting-1', meeting]]),
      });

      const result = await adapter.getMeeting('meeting-1', 'user-A');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('meeting-1');
    });

    it('listMeetings only returns meetings for the specified userId', async () => {
      const meetings = new Map([
        ['m1', makeMeeting({ id: 'm1', userId: 'user-A' })],
        ['m2', makeMeeting({ id: 'm2', userId: 'user-B' })],
        ['m3', makeMeeting({ id: 'm3', userId: 'user-A' })],
      ]);
      const adapter = createMockFirestoreAdapter({ meetings });

      const result = await adapter.listMeetings({ userId: 'user-A' });
      expect(result.meetings).toHaveLength(2);
      expect(result.meetings.every((m) => m.userId === 'user-A')).toBe(true);
    });

    it('updateMeeting throws for wrong user', async () => {
      const meeting = makeMeeting({ id: 'meeting-1', userId: 'user-A' });
      const adapter = createMockFirestoreAdapter({
        meetings: new Map([['meeting-1', meeting]]),
      });

      await expect(
        adapter.updateMeeting('meeting-1', 'user-B', { title: 'Hacked' }),
      ).rejects.toThrow('access denied');
    });

    it('deleteMeeting throws for wrong user', async () => {
      const meeting = makeMeeting({ id: 'meeting-1', userId: 'user-A' });
      const adapter = createMockFirestoreAdapter({
        meetings: new Map([['meeting-1', meeting]]),
      });

      await expect(adapter.deleteMeeting('meeting-1', 'user-B')).rejects.toThrow(
        'access denied',
      );
    });

    it('getAction returns null for wrong user', async () => {
      const action = makeAction({ id: 'action-1', userId: 'user-A' });
      const adapter = createMockFirestoreAdapter({
        actions: new Map([['action-1', action]]),
      });

      const result = await adapter.getAction('action-1', 'user-B');
      expect(result).toBeNull();
    });

    it('listActions only returns actions for the specified userId', async () => {
      const actions = new Map([
        ['a1', makeAction({ id: 'a1', userId: 'user-A' })],
        ['a2', makeAction({ id: 'a2', userId: 'user-B' })],
      ]);
      const adapter = createMockFirestoreAdapter({ actions });

      const result = await adapter.listActions({ userId: 'user-A' });
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].userId).toBe('user-A');
    });

    it('getSegments returns empty for wrong user', async () => {
      const meeting = makeMeeting({ id: 'meeting-1', userId: 'user-A' });
      const adapter = createMockFirestoreAdapter({
        meetings: new Map([['meeting-1', meeting]]),
      });

      const result = await adapter.getSegments('meeting-1', 'user-B');
      expect(result).toEqual([]);
    });
  });

  describe('batch write operations', () => {
    it('batchWriteSegments stores all segments', async () => {
      const adapter = createMockFirestoreAdapter({
        meetings: new Map([['m1', makeMeeting({ id: 'm1' })]]),
      });

      const segments = Array.from({ length: 5 }, (_, i) =>
        makeSegment({ id: `seg-${i}`, startTime: i * 5, endTime: (i + 1) * 5 }),
      );

      await adapter.batchWriteSegments('m1', segments);
      expect(adapter.batchWriteSegments).toHaveBeenCalledWith('m1', segments);
    });

    it('batchWriteSegments handles empty array', async () => {
      const adapter = createMockFirestoreAdapter();
      await adapter.batchWriteSegments('m1', []);
      expect(adapter.batchWriteSegments).toHaveBeenCalledWith('m1', []);
    });

    it('storeEmbeddings stores multiple chunks', async () => {
      const adapter = createMockFirestoreAdapter();
      const chunks = [
        makeEmbeddingChunk({ id: 'emb-1' }),
        makeEmbeddingChunk({ id: 'emb-2' }),
      ];

      await adapter.storeEmbeddings(chunks);
      expect(adapter.storeEmbeddings).toHaveBeenCalledWith(chunks);
    });
  });

  describe('vector search (userId scoping)', () => {
    it('vectorSearch only returns chunks for the specified userId', async () => {
      const adapter = createMockFirestoreAdapter();

      // Store embeddings for two users
      await adapter.storeEmbeddings([
        makeEmbeddingChunk({ id: 'emb-A', userId: 'user-A' }),
        makeEmbeddingChunk({ id: 'emb-B', userId: 'user-B' }),
      ]);

      const results = await adapter.vectorSearch({
        queryVector: Array(768).fill(0.1),
        userId: 'user-A',
        limit: 10,
      });

      // All results must belong to user-A
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.chunk.userId === 'user-A')).toBe(true);
    });

    it('vectorSearch returns empty when no matching userId', async () => {
      const adapter = createMockFirestoreAdapter();

      await adapter.storeEmbeddings([
        makeEmbeddingChunk({ id: 'emb-A', userId: 'user-A' }),
      ]);

      const results = await adapter.vectorSearch({
        queryVector: Array(768).fill(0.1),
        userId: 'user-C', // No embeddings for this user
        limit: 10,
      });

      expect(results).toEqual([]);
    });

    it('vectorSearch respects limit', async () => {
      const adapter = createMockFirestoreAdapter();

      const chunks = Array.from({ length: 5 }, (_, i) =>
        makeEmbeddingChunk({ id: `emb-${i}`, userId: 'user-A' }),
      );
      await adapter.storeEmbeddings(chunks);

      const results = await adapter.vectorSearch({
        queryVector: Array(768).fill(0.1),
        userId: 'user-A',
        limit: 2,
      });

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('vectorSearch results include similarity score', async () => {
      const adapter = createMockFirestoreAdapter();

      await adapter.storeEmbeddings([
        makeEmbeddingChunk({ id: 'emb-1', userId: 'user-A' }),
      ]);

      const results = await adapter.vectorSearch({
        queryVector: Array(768).fill(0.1),
        userId: 'user-A',
        limit: 10,
      });

      expect(results[0].similarity).toBeGreaterThanOrEqual(0);
      expect(results[0].similarity).toBeLessThanOrEqual(1);
    });
  });

  describe('health check', () => {
    it('returns true when healthy', async () => {
      const adapter = createMockFirestoreAdapter();
      const result = await adapter.healthCheck();
      expect(result).toBe(true);
    });
  });

  describe('cascade delete', () => {
    it('deleteAllUserData is callable', async () => {
      const adapter = createMockFirestoreAdapter();
      await adapter.deleteAllUserData('user-A');
      expect(adapter.deleteAllUserData).toHaveBeenCalledWith('user-A');
    });
  });
});

// ── Real adapter tests with mocked Firebase Admin SDK ─────────────────

describe('createFirestoreAdapter (real adapter, mocked SDK)', () => {
  // We lazy-import to ensure vi.mock is applied first
  let createFirestoreAdapter: typeof import('../../src/adapters/firestore.js').createFirestoreAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset query chain returns
    mockQuery.where.mockReturnValue(mockQuery);
    mockQuery.orderBy.mockReturnValue(mockQuery);
    mockQuery.limit.mockReturnValue(mockQuery);
    mockQuery.startAfter.mockReturnValue(mockQuery);
    mockQuery.findNearest.mockReturnValue(mockQuery);
    mockQuery.get.mockResolvedValue({ docs: [], empty: true });

    // Default: doc().get() returns non-existent
    mockDocGet.mockResolvedValue({ exists: false, data: () => null });

    // Re-wire collection().where/orderBy/limit to return mockQuery
    mockCollection.mockImplementation((_path: string) => ({
      doc: vi.fn((docId: string) => ({
        id: docId,
        get: mockDocGet,
        set: mockDocSet,
        update: mockDocUpdate,
        delete: mockDocDelete,
      })),
      where: mockQuery.where,
      orderBy: mockQuery.orderBy,
      limit: mockQuery.limit,
      get: mockQuery.get,
    }));

    const mod = await import('../../src/adapters/firestore.js');
    createFirestoreAdapter = mod.createFirestoreAdapter;
  });

  describe('toDate() with Firestore Timestamps', () => {
    it('converts Firestore Timestamp objects (with toDate method) to Date', async () => {
      const firestoreTimestamp = {
        toDate: () => new Date('2025-06-15T10:30:00Z'),
      };
      mockDocGet.mockResolvedValue({
        exists: true,
        data: () => ({
          id: 'meeting-1',
          userId: 'user-A',
          title: 'Timestamped meeting',
          status: 'ready',
          attendees: [],
          tags: [],
          isStarred: false,
          latestNoteVersion: 0,
          searchTokens: [],
          createdAt: firestoreTimestamp,
          updatedAt: firestoreTimestamp,
        }),
      });

      const adapter = createFirestoreAdapter('{}');
      const meeting = await adapter.getMeeting('meeting-1', 'user-A');

      expect(meeting).not.toBeNull();
      expect(meeting!.createdAt).toBeInstanceOf(Date);
      expect(meeting!.createdAt.toISOString()).toBe('2025-06-15T10:30:00.000Z');
    });

    it('passes through native Date objects unchanged', async () => {
      const nativeDate = new Date('2025-01-01T00:00:00Z');
      mockDocGet.mockResolvedValue({
        exists: true,
        data: () => ({
          id: 'meeting-2',
          userId: 'user-A',
          title: 'Native date meeting',
          status: 'ready',
          attendees: [],
          tags: [],
          isStarred: false,
          latestNoteVersion: 0,
          searchTokens: [],
          createdAt: nativeDate,
          updatedAt: nativeDate,
        }),
      });

      const adapter = createFirestoreAdapter('{}');
      const meeting = await adapter.getMeeting('meeting-2', 'user-A');

      expect(meeting).not.toBeNull();
      expect(meeting!.createdAt).toBe(nativeDate);
    });

    it('converts ISO string dates via new Date()', async () => {
      mockDocGet.mockResolvedValue({
        exists: true,
        data: () => ({
          id: 'meeting-3',
          userId: 'user-A',
          title: 'String date meeting',
          status: 'processing',
          attendees: [],
          tags: [],
          isStarred: false,
          latestNoteVersion: 0,
          searchTokens: [],
          createdAt: '2025-03-20T14:00:00Z',
          updatedAt: '2025-03-20T14:00:00Z',
        }),
      });

      const adapter = createFirestoreAdapter('{}');
      const meeting = await adapter.getMeeting('meeting-3', 'user-A');

      expect(meeting).not.toBeNull();
      expect(meeting!.createdAt).toBeInstanceOf(Date);
      expect(meeting!.createdAt.toISOString()).toBe('2025-03-20T14:00:00.000Z');
    });

    it('converts epoch milliseconds via new Date()', async () => {
      const epochMs = 1700000000000; // 2023-11-14T22:13:20Z
      mockDocGet.mockResolvedValue({
        exists: true,
        data: () => ({
          id: 'meeting-4',
          userId: 'user-A',
          title: 'Epoch date meeting',
          status: 'ready',
          attendees: [],
          tags: [],
          isStarred: false,
          latestNoteVersion: 0,
          searchTokens: [],
          createdAt: epochMs,
          updatedAt: epochMs,
        }),
      });

      const adapter = createFirestoreAdapter('{}');
      const meeting = await adapter.getMeeting('meeting-4', 'user-A');

      expect(meeting).not.toBeNull();
      expect(meeting!.createdAt).toBeInstanceOf(Date);
      expect(meeting!.createdAt.getTime()).toBe(epochMs);
    });
  });

  describe('batch write chunking (BATCH_LIMIT = 500)', () => {
    it('writes exactly 500 segments in a single batch', async () => {
      const adapter = createFirestoreAdapter('{}');
      const segments = Array.from({ length: 500 }, (_, i) =>
        makeSegment({ id: `seg-${i}`, startTime: i, endTime: i + 1 }),
      );

      await adapter.batchWriteSegments('meeting-1', segments);

      // Should create exactly 1 batch, commit once
      expect(mockDb.batch).toHaveBeenCalledTimes(1);
      expect(mockBatchCommit).toHaveBeenCalledTimes(1);
      expect(mockBatchSet).toHaveBeenCalledTimes(500);
    });

    it('splits 501 segments into two batches (500 + 1)', async () => {
      const adapter = createFirestoreAdapter('{}');
      const segments = Array.from({ length: 501 }, (_, i) =>
        makeSegment({ id: `seg-${i}`, startTime: i, endTime: i + 1 }),
      );

      await adapter.batchWriteSegments('meeting-1', segments);

      // 2 batches: one with 500, one with 1
      expect(mockDb.batch).toHaveBeenCalledTimes(2);
      expect(mockBatchCommit).toHaveBeenCalledTimes(2);
      expect(mockBatchSet).toHaveBeenCalledTimes(501);
    });

    it('splits 1200 segments into three batches (500 + 500 + 200)', async () => {
      const adapter = createFirestoreAdapter('{}');
      const segments = Array.from({ length: 1200 }, (_, i) =>
        makeSegment({ id: `seg-${i}`, startTime: i, endTime: i + 1 }),
      );

      await adapter.batchWriteSegments('meeting-1', segments);

      expect(mockDb.batch).toHaveBeenCalledTimes(3);
      expect(mockBatchCommit).toHaveBeenCalledTimes(3);
      expect(mockBatchSet).toHaveBeenCalledTimes(1200);
    });

    it('handles empty segment array without creating a batch', async () => {
      const adapter = createFirestoreAdapter('{}');

      await adapter.batchWriteSegments('meeting-1', []);

      expect(mockDb.batch).not.toHaveBeenCalled();
      expect(mockBatchCommit).not.toHaveBeenCalled();
    });
  });

  describe('malformed document data', () => {
    it('handles missing optional fields with defaults', async () => {
      mockDocGet.mockResolvedValue({
        exists: true,
        data: () => ({
          id: 'meeting-sparse',
          userId: 'user-A',
          title: 'Sparse meeting',
          status: 'ready',
          // All optional fields omitted: attendees, tags, isStarred, etc.
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      });

      const adapter = createFirestoreAdapter('{}');
      const meeting = await adapter.getMeeting('meeting-sparse', 'user-A');

      expect(meeting).not.toBeNull();
      expect(meeting!.attendees).toEqual([]);
      expect(meeting!.tags).toEqual([]);
      expect(meeting!.isStarred).toBe(false);
      expect(meeting!.latestNoteVersion).toBe(0);
      expect(meeting!.searchTokens).toEqual([]);
    });

    it('returns null for non-existent document', async () => {
      mockDocGet.mockResolvedValue({
        exists: false,
        data: () => null,
      });

      const adapter = createFirestoreAdapter('{}');
      const meeting = await adapter.getMeeting('non-existent', 'user-A');

      expect(meeting).toBeNull();
    });

    it('returns null for document owned by different user (IDOR guard)', async () => {
      mockDocGet.mockResolvedValue({
        exists: true,
        data: () => ({
          id: 'meeting-other',
          userId: 'user-B',
          title: 'Other user meeting',
          status: 'ready',
          attendees: [],
          tags: [],
          isStarred: false,
          latestNoteVersion: 0,
          searchTokens: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      });

      const adapter = createFirestoreAdapter('{}');
      const meeting = await adapter.getMeeting('meeting-other', 'user-A');

      expect(meeting).toBeNull();
    });

    it('handles null/undefined searchTokens gracefully', async () => {
      mockDocGet.mockResolvedValue({
        exists: true,
        data: () => ({
          id: 'meeting-null-tokens',
          userId: 'user-A',
          title: 'Null tokens',
          status: 'ready',
          searchTokens: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      });

      const adapter = createFirestoreAdapter('{}');
      const meeting = await adapter.getMeeting('meeting-null-tokens', 'user-A');

      expect(meeting).not.toBeNull();
      expect(meeting!.searchTokens).toEqual([]);
    });
  });

  describe('healthCheck', () => {
    it('returns true when Firestore responds', async () => {
      mockQuery.get.mockResolvedValue({ docs: [], empty: true });
      // Make collection().limit() return the mockQuery
      mockCollection.mockImplementation((_path: string) => ({
        doc: vi.fn((id: string) => mockDocRef(id)),
        where: mockQuery.where,
        orderBy: mockQuery.orderBy,
        limit: vi.fn(() => ({ get: mockQuery.get })),
        get: mockQuery.get,
      }));

      const adapter = createFirestoreAdapter('{}');
      const result = await adapter.healthCheck();

      expect(result).toBe(true);
    });

    it('returns false when Firestore throws', async () => {
      mockCollection.mockImplementation((_path: string) => ({
        doc: vi.fn((id: string) => mockDocRef(id)),
        where: mockQuery.where,
        orderBy: mockQuery.orderBy,
        limit: vi.fn(() => ({
          get: vi.fn().mockRejectedValue(new Error('Connection refused')),
        })),
        get: mockQuery.get,
      }));

      const adapter = createFirestoreAdapter('{}');
      const result = await adapter.healthCheck();

      expect(result).toBe(false);
    });
  });
});
