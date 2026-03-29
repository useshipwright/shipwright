/**
 * Search service tests — T-030 acceptance criteria.
 *
 * Tests full-text search (tokenized array queries with array-contains-any),
 * semantic search (embedding + vector nearest-neighbor), cursor-based pagination,
 * and userId scoping on all queries.
 *
 * Includes negative test for cross-user vector search leakage (T-043):
 * Verifies that vector nearest-neighbor queries always include userId filter,
 * and querying with user A's credentials never returns user B's embeddings.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSearchService, tokenizeQuery, type SearchService } from '../../src/services/search.js';
import type { FirestoreAdapter, VectorSearchResult, VectorSearchOptions } from '../../src/types/adapters.js';
import type { EmbeddingAdapter } from '../../src/types/adapters.js';
import type { EmbeddingChunk, Meeting, ActionItem } from '../../src/types/domain.js';

// --- Mock factories ---

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
    listConnectedCalendarUsers: vi.fn(),
  };
}

function mockEmbeddingAdapter(): EmbeddingAdapter {
  return {
    embed: vi.fn().mockResolvedValue([new Array(768).fill(0.5)]),
  };
}

// --- Fixtures ---

const USER_A_ID = 'user-a-111';
const USER_B_ID = 'user-b-222';

const userAEmbeddingChunk: EmbeddingChunk = {
  id: 'chunk-a-1',
  userId: USER_A_ID,
  meetingId: 'meeting-a-1',
  source: 'transcript',
  text: 'User A discussed quarterly targets',
  embedding: new Array(768).fill(0.1),
  meetingTitle: 'Q4 Planning',
  meetingDate: new Date('2026-01-15'),
  createdAt: new Date('2026-01-15'),
};

const userBEmbeddingChunk: EmbeddingChunk = {
  id: 'chunk-b-1',
  userId: USER_B_ID,
  meetingId: 'meeting-b-1',
  source: 'transcript',
  text: 'User B discussed confidential HR matters',
  embedding: new Array(768).fill(0.2),
  meetingTitle: 'HR Review',
  meetingDate: new Date('2026-01-15'),
  createdAt: new Date('2026-01-15'),
};

function makeMeeting(id: string, userId: string): Meeting {
  return {
    id,
    userId,
    title: `Meeting ${id}`,
    status: 'ready',
    attendees: [],
    tags: [],
    isStarred: false,
    latestNoteVersion: 0,
    searchTokens: ['meeting', id],
    createdAt: new Date('2026-01-15'),
    updatedAt: new Date('2026-01-15'),
  };
}

function makeActionItem(id: string, userId: string): ActionItem {
  return {
    id,
    userId,
    title: `Action ${id}`,
    text: `Action ${id}`,
    status: 'open',
    source: 'manual',
    searchTokens: ['action', id],
    createdAt: new Date('2026-01-15'),
    updatedAt: new Date('2026-01-15'),
  };
}

// --- tokenizeQuery unit tests ---

describe('tokenizeQuery', () => {
  it('should lowercase and split on whitespace', () => {
    expect(tokenizeQuery('Hello World')).toEqual(['hello', 'world']);
  });

  it('should filter stop words', () => {
    const tokens = tokenizeQuery('the quick brown fox is a legend');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('is');
    expect(tokens).not.toContain('a');
    expect(tokens).toContain('quick');
    expect(tokens).toContain('brown');
    expect(tokens).toContain('fox');
  });

  it('should deduplicate tokens', () => {
    const tokens = tokenizeQuery('hello hello hello world');
    expect(tokens.filter((t) => t === 'hello')).toHaveLength(1);
  });

  it('should limit to 10 tokens (Firestore array-contains-any limit)', () => {
    const longQuery = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    const tokens = tokenizeQuery(longQuery);
    expect(tokens.length).toBeLessThanOrEqual(10);
  });

  it('should split on punctuation', () => {
    const tokens = tokenizeQuery('hello-world foo.bar baz!');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
    expect(tokens).toContain('foo');
  });

  it('should return empty for stop-word-only queries', () => {
    expect(tokenizeQuery('the is a')).toEqual([]);
  });
});

// --- SearchService unit tests ---

describe('SearchService', () => {
  let searchService: SearchService;
  let firestoreAdapter: ReturnType<typeof mockFirestore>;
  let embeddingAdapter: ReturnType<typeof mockEmbeddingAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    firestoreAdapter = mockFirestore();
    embeddingAdapter = mockEmbeddingAdapter();
    searchService = createSearchService({
      firestoreAdapter,
      embeddingAdapter,
    });
  });

  describe('fullTextSearch', () => {
    it('should tokenize query and search meetings via array-contains-any', async () => {
      (firestoreAdapter.searchMeetings as ReturnType<typeof vi.fn>).mockResolvedValue({
        meetings: [makeMeeting('m1', USER_A_ID)],
      });
      (firestoreAdapter.searchActions as ReturnType<typeof vi.fn>).mockResolvedValue({
        actions: [],
      });

      const result = await searchService.fullTextSearch({
        query: 'quarterly planning',
        userId: USER_A_ID,
      });

      expect(firestoreAdapter.searchMeetings).toHaveBeenCalledWith(
        USER_A_ID,
        expect.arrayContaining(['quarterly', 'planning']),
        undefined,
        21, // limit + 1 for pagination detection
      );
      expect(result.meetings).toHaveLength(1);
    });

    it('should search action items when type is actions', async () => {
      (firestoreAdapter.searchActions as ReturnType<typeof vi.fn>).mockResolvedValue({
        actions: [makeActionItem('a1', USER_A_ID)],
      });

      const result = await searchService.fullTextSearch({
        query: 'review',
        userId: USER_A_ID,
        type: 'actions',
      });

      expect(result.actions).toHaveLength(1);
      expect(firestoreAdapter.searchMeetings).not.toHaveBeenCalled();
    });

    it('should return empty results for stop-word-only query', async () => {
      const result = await searchService.fullTextSearch({
        query: 'the is a',
        userId: USER_A_ID,
      });

      expect(result.meetings).toEqual([]);
      expect(result.actions).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it('should support cursor-based pagination', async () => {
      // Return limit+1 items to indicate more results
      const meetings = Array.from({ length: 21 }, (_, i) =>
        makeMeeting(`m${i}`, USER_A_ID),
      );
      (firestoreAdapter.searchMeetings as ReturnType<typeof vi.fn>).mockResolvedValue({
        meetings,
        cursor: 'cursor-abc',
      });
      (firestoreAdapter.searchActions as ReturnType<typeof vi.fn>).mockResolvedValue({
        actions: [],
      });

      const result = await searchService.fullTextSearch({
        query: 'roadmap',
        userId: USER_A_ID,
        limit: 20,
      });

      expect(result.hasMore).toBe(true);
      expect(result.meetings).toHaveLength(20);
      expect(result.cursor).toBe('cursor-abc');
    });

    it('should scope all queries to userId', async () => {
      (firestoreAdapter.searchMeetings as ReturnType<typeof vi.fn>).mockResolvedValue({ meetings: [] });
      (firestoreAdapter.searchActions as ReturnType<typeof vi.fn>).mockResolvedValue({ actions: [] });

      await searchService.fullTextSearch({
        query: 'test',
        userId: USER_A_ID,
      });

      // Both meeting and action searches must include userId
      expect(firestoreAdapter.searchMeetings).toHaveBeenCalledWith(
        USER_A_ID,
        expect.any(Array),
        undefined,
        expect.any(Number),
      );
      expect(firestoreAdapter.searchActions).toHaveBeenCalledWith(
        USER_A_ID,
        expect.any(Array),
        undefined,
        expect.any(Number),
      );
    });
  });

  describe('semanticSearch', () => {
    it('should generate embedding for query and perform vector search', async () => {
      const results: VectorSearchResult[] = [
        { chunk: userAEmbeddingChunk, similarity: 0.95 },
      ];
      (firestoreAdapter.vectorSearch as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const response = await searchService.semanticSearch({
        query: 'quarterly targets',
        userId: USER_A_ID,
      });

      expect(embeddingAdapter.embed).toHaveBeenCalledWith(['quarterly targets']);
      expect(firestoreAdapter.vectorSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_A_ID,
          queryVector: expect.any(Array),
          limit: 10, // default limit
        }),
      );
      expect(response.results).toHaveLength(1);
      expect(response.results[0].similarity).toBe(0.95);
    });

    it('should pass filters to vector search', async () => {
      (firestoreAdapter.vectorSearch as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await searchService.semanticSearch({
        query: 'meeting notes',
        userId: USER_A_ID,
        limit: 5,
        filters: { sourceType: 'notes' },
      });

      expect(firestoreAdapter.vectorSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_A_ID,
          limit: 5,
          filters: { sourceType: 'notes' },
        }),
      );
    });

    it('should return empty results when no matches found', async () => {
      (firestoreAdapter.vectorSearch as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const response = await searchService.semanticSearch({
        query: 'nonexistent topic',
        userId: USER_A_ID,
      });

      expect(response.results).toHaveLength(0);
    });
  });

  /**
   * T-043: Negative test for cross-user vector search leakage.
   *
   * Verifies that:
   * 1. Vector search always receives the authenticated userId
   * 2. User A's query never returns User B's embeddings
   * 3. The userId parameter is non-optional and always passed
   */
  describe('cross-user vector search isolation (T-043)', () => {
    it('should always include userId in vector search options', async () => {
      (firestoreAdapter.vectorSearch as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await searchService.semanticSearch({
        query: 'any query',
        userId: USER_A_ID,
      });

      const callArgs = (firestoreAdapter.vectorSearch as ReturnType<typeof vi.fn>).mock.calls[0][0] as VectorSearchOptions;
      expect(callArgs.userId).toBe(USER_A_ID);
      expect(callArgs.userId).toBeDefined();
    });

    it('should never return User B embeddings when querying as User A', async () => {
      // Mock: adapter returns only User A's chunks (as it should when filtered)
      const userAResults: VectorSearchResult[] = [
        { chunk: userAEmbeddingChunk, similarity: 0.9 },
      ];
      (firestoreAdapter.vectorSearch as ReturnType<typeof vi.fn>).mockResolvedValue(userAResults);

      const response = await searchService.semanticSearch({
        query: 'confidential HR matters',
        userId: USER_A_ID,
      });

      // Verify the query was scoped to User A
      const callArgs = (firestoreAdapter.vectorSearch as ReturnType<typeof vi.fn>).mock.calls[0][0] as VectorSearchOptions;
      expect(callArgs.userId).toBe(USER_A_ID);
      expect(callArgs.userId).not.toBe(USER_B_ID);

      // Verify no User B data in results
      for (const result of response.results) {
        expect(result.chunk.userId).not.toBe(USER_B_ID);
      }
    });

    it('should scope User B queries to User B only', async () => {
      const userBResults: VectorSearchResult[] = [
        { chunk: userBEmbeddingChunk, similarity: 0.85 },
      ];
      (firestoreAdapter.vectorSearch as ReturnType<typeof vi.fn>).mockResolvedValue(userBResults);

      const response = await searchService.semanticSearch({
        query: 'quarterly targets',
        userId: USER_B_ID,
      });

      // Verify the query was scoped to User B
      const callArgs = (firestoreAdapter.vectorSearch as ReturnType<typeof vi.fn>).mock.calls[0][0] as VectorSearchOptions;
      expect(callArgs.userId).toBe(USER_B_ID);

      // Verify no User A data in results
      for (const result of response.results) {
        expect(result.chunk.userId).not.toBe(USER_A_ID);
      }
    });

    it('should make separate scoped queries for different users on same content', async () => {
      // User A searches
      (firestoreAdapter.vectorSearch as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { chunk: userAEmbeddingChunk, similarity: 0.9 },
      ]);
      await searchService.semanticSearch({
        query: 'shared topic',
        userId: USER_A_ID,
      });

      // User B searches same query
      (firestoreAdapter.vectorSearch as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { chunk: userBEmbeddingChunk, similarity: 0.88 },
      ]);
      await searchService.semanticSearch({
        query: 'shared topic',
        userId: USER_B_ID,
      });

      // Verify both calls had correct userId scoping
      expect(firestoreAdapter.vectorSearch).toHaveBeenCalledTimes(2);
      expect((firestoreAdapter.vectorSearch as ReturnType<typeof vi.fn>).mock.calls[0][0].userId).toBe(USER_A_ID);
      expect((firestoreAdapter.vectorSearch as ReturnType<typeof vi.fn>).mock.calls[1][0].userId).toBe(USER_B_ID);
    });
  });
});

// --- Integration test: verify search route is wired via production entry point ---

describe('Search route wiring (integration)', () => {
  it('should wire search routes through production buildApp', async () => {
    const { buildApp } = await import('../../src/app.js');
    const mockFs = mockFirestore();
    (mockFs.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const stubService = {
      create: vi.fn(),
      list: vi.fn(),
      getById: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      listByMeeting: vi.fn(),
      getSummary: vi.fn(),
    };

    const deps = {
      firestore: mockFs,
      gcs: { upload: vi.fn(), createWriteStream: vi.fn(), getSignedUrl: vi.fn(), delete: vi.fn(), deleteByPrefix: vi.fn(), healthCheck: vi.fn().mockResolvedValue(true) },
      meetingService: { create: vi.fn(), list: vi.fn(), getById: vi.fn(), update: vi.fn(), delete: vi.fn(), getTranscript: vi.fn(), getSpeakers: vi.fn(), updateSpeaker: vi.fn(), getNotes: vi.fn(), getNote: vi.fn(), getLatestNote: vi.fn(), updateNote: vi.fn() } as never,
      templateService: { list: vi.fn(), getById: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), seedSystemTemplates: vi.fn() } as never,
      audioService: { uploadAudio: vi.fn(), getAudioUrl: vi.fn(), streamAudio: vi.fn() } as never,
      userNotesService: { create: vi.fn(), list: vi.fn() } as never,
      aiNotesService: { generate: vi.fn() } as never,
      actionService: stubService as never,
      searchService: createSearchService({ firestoreAdapter: mockFs, embeddingAdapter: mockEmbeddingAdapter() }) as never,
      aiQaService: { askQuestion: vi.fn(), meetingPrep: vi.fn() } as never,
      calendarService: { connect: vi.fn(), callback: vi.fn(), listEvents: vi.fn(), sync: vi.fn(), disconnect: vi.fn() } as never,
      shareService: { create: vi.fn(), getByShareId: vi.fn(), listByMeeting: vi.fn(), revoke: vi.fn() } as never,
      userService: { getProfile: vi.fn(), updatePreferences: vi.fn(), deleteAccount: vi.fn() } as never,
      audioProcessorDeps: { firestore: mockFs, gcs: {} as never, transcription: {} as never, claude: {} as never, embedding: {} as never } as never,
      calendarSyncWorkerDeps: { firestore: mockFs, calendarAdapter: {} as never } as never,
    };

    const app = await buildApp(deps as never);
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);

      // Search routes should return 401 without auth (proves they are wired)
      const searchRes = await app.inject({ method: 'GET', url: '/api/search?q=test' });
      expect(searchRes.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
