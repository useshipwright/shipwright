/**
 * AI Q&A service unit tests — T-030.
 *
 * Tests the RAG pipeline (embed question → retrieve top-20 chunks →
 * build Claude prompt with cited context → generate answer with citations),
 * meeting prep (attendee overlap → past meetings → prep brief), and
 * userId scoping on all queries.
 *
 * Strategy: Mock adapter interfaces (ClaudeAdapter, EmbeddingAdapter, FirestoreAdapter).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { createAiQaService } from '../../src/services/ai-qa.js';
import type {
  FirestoreAdapter,
  ClaudeAdapter,
  EmbeddingAdapter,
  VectorSearchResult,
} from '../../src/types/adapters.js';
import type { Meeting, MeetingNote, EmbeddingChunk } from '../../src/types/domain.js';

// ── Mock factories ───────────────────────────────────────────────────

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

function mockClaude(): ClaudeAdapter {
  return {
    generate: vi.fn(),
  };
}

function mockEmbedding(): EmbeddingAdapter {
  return {
    embed: vi.fn().mockResolvedValue([new Array(768).fill(0.5)]),
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────

const USER_ID = 'user-123';
const OTHER_USER_ID = 'user-other';

function makeChunk(meetingId: string, userId: string, text: string): EmbeddingChunk {
  return {
    id: `chunk-${meetingId}`,
    meetingId,
    userId,
    source: 'notes',
    sectionHeading: 'Summary',
    text,
    embedding: new Array(768).fill(0.1),
    meetingTitle: `Meeting ${meetingId}`,
    meetingDate: new Date('2026-01-15'),
    createdAt: new Date('2026-01-15'),
  };
}

function makeMeeting(id: string, overrides: Partial<Meeting> = {}): Meeting {
  return {
    id,
    userId: USER_ID,
    title: `Meeting ${id}`,
    status: 'ready',
    attendees: [
      { name: 'Alice', email: 'alice@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
    ],
    tags: [],
    isStarred: false,
    latestNoteVersion: 1,
    searchTokens: [],
    createdAt: new Date('2026-01-15'),
    updatedAt: new Date('2026-01-15'),
    ...overrides,
  };
}

function makeNote(): MeetingNote {
  return {
    version: 1,
    templateId: 'template-1',
    sections: [
      { heading: 'Summary', content: 'Discussion about Q4 goals.' },
      { heading: 'Key Points', content: 'Budget approved. Timeline set.' },
    ],
    isEdited: false,
    model: 'claude-sonnet-4-20250514',
    inputTokens: 200,
    outputTokens: 100,
    generationLatencyMs: 1000,
    generatedAt: new Date('2026-01-15'),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('AiQaService', () => {
  let firestore: ReturnType<typeof mockFirestore>;
  let claude: ReturnType<typeof mockClaude>;
  let embedding: ReturnType<typeof mockEmbedding>;
  let service: ReturnType<typeof createAiQaService>;

  beforeEach(() => {
    vi.clearAllMocks();
    firestore = mockFirestore();
    claude = mockClaude();
    embedding = mockEmbedding();
    service = createAiQaService({
      firestoreAdapter: firestore,
      embeddingAdapter: embedding,
      claudeAdapter: claude,
    });
  });

  describe('askQuestion() — RAG pipeline', () => {
    it('should embed question, retrieve top-20 chunks, and build Claude prompt', async () => {
      const chunks: VectorSearchResult[] = [
        { chunk: makeChunk('m1', USER_ID, 'Q4 planning discussed'), similarity: 0.95 },
        { chunk: makeChunk('m2', USER_ID, 'Budget was approved'), similarity: 0.85 },
      ];
      (firestore.vectorSearch as ReturnType<typeof vi.fn>).mockResolvedValue(chunks);
      (claude.generate as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'Based on your meetings, Q4 planning was discussed and budget was approved.',
        model: 'claude-sonnet-4-20250514',
        inputTokens: 300,
        outputTokens: 50,
        latencyMs: 1200,
      });

      const result = await service.askQuestion({
        question: 'What was discussed about Q4?',
        userId: USER_ID,
      });

      // 1. Embed the question
      expect(embedding.embed).toHaveBeenCalledWith(['What was discussed about Q4?']);

      // 2. Vector search with userId and top-K
      expect(firestore.vectorSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          limit: 20,
          queryVector: expect.any(Array),
        }),
      );

      // 3. Claude prompt contains context chunks
      const prompt = (claude.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(prompt).toContain('<retrieved_context>');
      expect(prompt).toContain('<user_question>');
      expect(prompt).toContain('Q4 planning discussed');
      expect(prompt).toContain('Budget was approved');
      expect(prompt).toContain('What was discussed about Q4?');

      // 4. Result contains answer and citations
      expect(result.answer).toContain('Q4 planning');
      expect(result.model).toBe('claude-sonnet-4-20250514');
    });

    it('should include meeting citations with source references', async () => {
      const chunks: VectorSearchResult[] = [
        { chunk: makeChunk('meeting-abc', USER_ID, 'Revenue grew 20%'), similarity: 0.92 },
      ];
      (firestore.vectorSearch as ReturnType<typeof vi.fn>).mockResolvedValue(chunks);
      (claude.generate as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'Revenue grew 20%.',
        model: 'claude-sonnet-4-20250514',
        inputTokens: 200,
        outputTokens: 30,
        latencyMs: 800,
      });

      const result = await service.askQuestion({
        question: 'What about revenue?',
        userId: USER_ID,
      });

      expect(result.citations).toHaveLength(1);
      expect(result.citations[0].meetingId).toBe('meeting-abc');
      expect(result.citations[0].meetingTitle).toBe('Meeting meeting-abc');
      expect(result.citations[0].sectionHeading).toBe('Summary');
      expect(result.citations[0].text).toBe('Revenue grew 20%');
    });

    it('should return no-results response when no chunks found', async () => {
      (firestore.vectorSearch as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await service.askQuestion({
        question: 'Something with no results',
        userId: USER_ID,
      });

      expect(result.answer).toContain('could not find');
      expect(result.citations).toHaveLength(0);
      expect(claude.generate).not.toHaveBeenCalled();
    });

    it('should scope vectorSearch to userId (prevents cross-user leakage)', async () => {
      (firestore.vectorSearch as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await service.askQuestion({
        question: 'test',
        userId: USER_ID,
      });

      const searchArgs = (firestore.vectorSearch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(searchArgs.userId).toBe(USER_ID);
    });
  });

  describe('meetingPrep() — attendee overlap', () => {
    it('should find past meetings by attendee overlap and generate prep brief', async () => {
      const sourceMeeting = makeMeeting('upcoming', {
        attendees: [
          { name: 'Alice', email: 'alice@example.com' },
          { name: 'Carol', email: 'carol@example.com' },
        ],
      });
      const pastMeeting = makeMeeting('past-1', {
        attendees: [
          { name: 'Alice', email: 'alice@example.com' },
          { name: 'Bob', email: 'bob@example.com' },
        ],
      });

      (firestore.getMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(sourceMeeting);
      (firestore.listMeetings as ReturnType<typeof vi.fn>).mockResolvedValue({
        meetings: [sourceMeeting, pastMeeting],
      });
      (firestore.getLatestNote as ReturnType<typeof vi.fn>).mockResolvedValue(makeNote());
      (claude.generate as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'Meeting prep brief: Previously discussed Q4 goals with Alice.',
        model: 'claude-sonnet-4-20250514',
        inputTokens: 400,
        outputTokens: 100,
        latencyMs: 1500,
      });

      const result = await service.meetingPrep({
        userId: USER_ID,
        meetingId: 'upcoming',
      });

      expect(result.brief).toContain('Meeting prep brief');
      expect(result.meetings).toHaveLength(1); // Only past-1 (excludes source meeting)
      expect(result.meetings[0].id).toBe('past-1');

      // Verify prompt includes past meeting notes
      const prompt = (claude.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(prompt).toContain('<past_meetings>');
      expect(prompt).toContain('Q4 goals');
    });

    it('should accept attendeeEmails directly without meetingId', async () => {
      const pastMeeting = makeMeeting('past-1', {
        attendees: [{ name: 'Alice', email: 'alice@example.com' }],
      });

      (firestore.listMeetings as ReturnType<typeof vi.fn>).mockResolvedValue({
        meetings: [pastMeeting],
      });
      (firestore.getLatestNote as ReturnType<typeof vi.fn>).mockResolvedValue(makeNote());
      (claude.generate as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'Brief for meeting with Alice.',
        model: 'claude-sonnet-4-20250514',
        inputTokens: 200,
        outputTokens: 50,
        latencyMs: 800,
      });

      const result = await service.meetingPrep({
        userId: USER_ID,
        attendeeEmails: ['alice@example.com'],
      });

      expect(result.meetings).toHaveLength(1);
    });

    it('should return minimal result when no past meetings with overlapping attendees', async () => {
      const sourceMeeting = makeMeeting('upcoming', {
        attendees: [{ name: 'NewPerson', email: 'new@example.com' }],
      });

      (firestore.getMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(sourceMeeting);
      (firestore.listMeetings as ReturnType<typeof vi.fn>).mockResolvedValue({
        meetings: [sourceMeeting], // Only the source meeting
      });

      const result = await service.meetingPrep({
        userId: USER_ID,
        meetingId: 'upcoming',
      });

      expect(result.brief).toContain('No past meetings');
      expect(result.meetings).toHaveLength(0);
      expect(claude.generate).not.toHaveBeenCalled();
    });

    it('should throw 404 if meetingId not found', async () => {
      (firestore.getMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(
        service.meetingPrep({ userId: USER_ID, meetingId: 'nonexistent' }),
      ).rejects.toThrow('Meeting not found');
    });

    it('should throw 400 if no attendee emails provided', async () => {
      await expect(
        service.meetingPrep({ userId: USER_ID }),
      ).rejects.toThrow('Must provide meetingId with attendees or attendeeEmails');
    });
  });

  describe('userId scoping', () => {
    it('should scope vectorSearch to authenticated user', async () => {
      (firestore.vectorSearch as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await service.askQuestion({
        question: 'test',
        userId: USER_ID,
      });

      expect(firestore.vectorSearch).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_ID }),
      );
    });

    it('should scope listMeetings to authenticated user in meeting prep', async () => {
      (firestore.getMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeMeeting('m1', { attendees: [{ name: 'A', email: 'a@b.com' }] }),
      );
      (firestore.listMeetings as ReturnType<typeof vi.fn>).mockResolvedValue({ meetings: [] });

      await service.meetingPrep({
        userId: USER_ID,
        meetingId: 'm1',
      });

      expect(firestore.listMeetings).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_ID }),
      );
    });

    it('should never query with different userId than authenticated user', async () => {
      (firestore.vectorSearch as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await service.askQuestion({
        question: 'test',
        userId: USER_ID,
      });

      const callArgs = (firestore.vectorSearch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.userId).toBe(USER_ID);
      expect(callArgs.userId).not.toBe(OTHER_USER_ID);
    });
  });
});

// --- Integration test: verify AI routes are wired via production entry point ---

describe('AI route wiring (integration)', () => {
  it('should wire AI routes through production buildApp', async () => {
    const { buildApp } = await import('../../src/app.js');
    const mockFs = mockFirestore();
    (mockFs.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const deps = {
      firestore: mockFs,
      gcs: { upload: vi.fn(), createWriteStream: vi.fn(), getSignedUrl: vi.fn(), delete: vi.fn(), deleteByPrefix: vi.fn(), healthCheck: vi.fn().mockResolvedValue(true) },
      meetingService: { create: vi.fn(), list: vi.fn(), getById: vi.fn(), update: vi.fn(), delete: vi.fn(), getTranscript: vi.fn(), getSpeakers: vi.fn(), updateSpeaker: vi.fn(), getNotes: vi.fn(), getNote: vi.fn(), getLatestNote: vi.fn(), updateNote: vi.fn() } as never,
      templateService: { list: vi.fn(), getById: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), seedSystemTemplates: vi.fn() } as never,
      audioService: { uploadAudio: vi.fn(), getAudioUrl: vi.fn(), streamAudio: vi.fn() } as never,
      userNotesService: { create: vi.fn(), list: vi.fn() } as never,
      aiNotesService: { generate: vi.fn() } as never,
      actionService: { create: vi.fn(), list: vi.fn(), getById: vi.fn(), update: vi.fn(), delete: vi.fn(), listByMeeting: vi.fn(), getSummary: vi.fn() } as never,
      searchService: { fullTextSearch: vi.fn(), semanticSearch: vi.fn() } as never,
      aiQaService: createAiQaService({ firestoreAdapter: mockFs, embeddingAdapter: mockEmbedding(), claudeAdapter: mockClaude() }) as never,
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

      // AI routes should return 401 without auth (proves they are wired)
      const aiRes = await app.inject({ method: 'POST', url: '/api/ai/ask' });
      expect(aiRes.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
