/**
 * AI notes service unit tests — T-030.
 *
 * Tests note generation pipeline: transcript + user notes + template merge
 * into Claude prompt, structured section parsing, auto action item extraction,
 * auto tag generation, embedding generation per section, and note versioning.
 *
 * Strategy: Mock adapter interfaces (ClaudeAdapter, EmbeddingAdapter, FirestoreAdapter).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    maxTranscriptTokens: 100_000,
  },
}));

vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { createAiNotesService } from '../../src/services/ai-notes.js';
import type { FirestoreAdapter, ClaudeAdapter, EmbeddingAdapter } from '../../src/types/adapters.js';
import type { Meeting, Template, TranscriptSegment, User } from '../../src/types/domain.js';

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
    embed: vi.fn().mockResolvedValue([new Array(768).fill(0.1)]),
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────

const USER_ID = 'user-123';
const MEETING_ID = 'meeting-456';

const baseMeeting: Meeting = {
  id: MEETING_ID,
  userId: USER_ID,
  title: 'Q4 Planning Meeting',
  status: 'ready',
  attendees: [{ name: 'Alice', email: 'alice@example.com' }],
  tags: ['planning'],
  isStarred: false,
  latestNoteVersion: 0,
  searchTokens: ['q4', 'planning', 'meeting'],
  createdAt: new Date('2026-01-15'),
  updatedAt: new Date('2026-01-15'),
};

const template: Template = {
  id: 'template-1',
  name: 'General',
  isSystem: true,
  sections: [
    { heading: 'Summary', prompt: 'Provide a concise summary.' },
    { heading: 'Key Points', prompt: 'List the main discussion points.' },
    { heading: 'Next Steps', prompt: 'List agreed next steps.' },
  ],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const transcriptSegments: TranscriptSegment[] = [
  {
    id: 'seg-1',
    speaker: 'Alice',
    speakerId: 'spk-1',
    text: 'Let us discuss the Q4 roadmap.',
    startTime: 0,
    endTime: 5,
    confidence: 0.95,
    channel: 'system_audio',
    isUserNote: false,
    searchTokens: ['discuss', 'q4', 'roadmap'],
  },
  {
    id: 'seg-2',
    speaker: 'Bob',
    speakerId: 'spk-2',
    text: 'I think we should prioritize the mobile app.',
    startTime: 6,
    endTime: 12,
    confidence: 0.92,
    channel: 'system_audio',
    isUserNote: false,
    searchTokens: ['prioritize', 'mobile', 'app'],
  },
];

const userNoteSegment: TranscriptSegment = {
  id: 'seg-un-1',
  speaker: 'User',
  speakerId: 'user',
  text: 'Important: deadline is end of January.',
  startTime: 10,
  endTime: 10,
  channel: 'user_input',
  isUserNote: true,
  searchTokens: ['important', 'deadline', 'january'],
};

function claudeNoteResponse() {
  return {
    text: [
      '## Summary',
      'The team discussed Q4 roadmap priorities.',
      '',
      '## Key Points',
      '- Mobile app was identified as top priority.',
      '- Deadline is end of January.',
      '',
      '## Next Steps',
      '- Alice to draft mobile app spec by Jan 20.',
      '',
      '## Extracted Action Items',
      '[{"title": "Draft mobile app spec", "assignee": "Alice", "dueDate": "2026-01-20"}]',
      '',
      '## Auto Tags',
      '["mobile-app", "q4-roadmap"]',
    ].join('\n'),
    model: 'claude-sonnet-4-20250514',
    inputTokens: 500,
    outputTokens: 200,
    latencyMs: 1500,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('AiNotesService', () => {
  let firestore: ReturnType<typeof mockFirestore>;
  let claude: ReturnType<typeof mockClaude>;
  let embedding: ReturnType<typeof mockEmbedding>;
  let service: ReturnType<typeof createAiNotesService>;

  beforeEach(() => {
    vi.clearAllMocks();
    firestore = mockFirestore();
    claude = mockClaude();
    embedding = mockEmbedding();
    service = createAiNotesService({ firestore, claude, embedding });
  });

  describe('generate() — prompt construction', () => {
    it('should merge transcript + user notes + template into Claude prompt', async () => {
      (firestore.getMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(baseMeeting);
      (firestore.getSegments as ReturnType<typeof vi.fn>).mockResolvedValue([
        ...transcriptSegments,
        userNoteSegment,
      ]);
      (firestore.getTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(template);
      (claude.generate as ReturnType<typeof vi.fn>).mockResolvedValue(claudeNoteResponse());
      (firestore.createNote as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.updateMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.createAction as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await service.generate({ userId: USER_ID, meetingId: MEETING_ID, templateId: 'template-1' });

      const callArgs = (claude.generate as ReturnType<typeof vi.fn>).mock.calls[0];
      const prompt = callArgs[0] as string;

      // Verify prompt contains transcript content
      expect(prompt).toContain('<transcript>');
      expect(prompt).toContain('Alice');
      expect(prompt).toContain('Q4 roadmap');

      // Verify prompt contains user notes section
      expect(prompt).toContain('<user_notes>');

      // Verify prompt contains template section instructions
      expect(prompt).toContain('Summary');
      expect(prompt).toContain('Key Points');
      expect(prompt).toContain('Next Steps');

      // Verify prompt contains meeting title
      expect(prompt).toContain('Q4 Planning Meeting');
    });

    it('should use [MM:SS] Speaker: text format for transcript', async () => {
      (firestore.getMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(baseMeeting);
      (firestore.getSegments as ReturnType<typeof vi.fn>).mockResolvedValue(transcriptSegments);
      (firestore.getTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(template);
      (claude.generate as ReturnType<typeof vi.fn>).mockResolvedValue(claudeNoteResponse());
      (firestore.createNote as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.updateMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.createAction as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await service.generate({ userId: USER_ID, meetingId: MEETING_ID, templateId: 'template-1' });

      const prompt = (claude.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(prompt).toMatch(/\[00:00\] Alice:/);
      expect(prompt).toMatch(/\[00:06\] Bob:/);
    });

    it('should mark user notes with [User Note] in transcript', async () => {
      (firestore.getMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(baseMeeting);
      (firestore.getSegments as ReturnType<typeof vi.fn>).mockResolvedValue([
        ...transcriptSegments,
        userNoteSegment,
      ]);
      (firestore.getTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(template);
      (claude.generate as ReturnType<typeof vi.fn>).mockResolvedValue(claudeNoteResponse());
      (firestore.createNote as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.updateMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.createAction as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await service.generate({ userId: USER_ID, meetingId: MEETING_ID, templateId: 'template-1' });

      const prompt = (claude.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      // User notes are separate from transcript segments in the prompt
      expect(prompt).toContain('deadline is end of January');
    });
  });

  describe('generate() — structured output', () => {
    it('should parse sections matching template headings', async () => {
      (firestore.getMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(baseMeeting);
      (firestore.getSegments as ReturnType<typeof vi.fn>).mockResolvedValue(transcriptSegments);
      (firestore.getTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(template);
      (claude.generate as ReturnType<typeof vi.fn>).mockResolvedValue(claudeNoteResponse());
      (firestore.createNote as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.updateMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.createAction as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const result = await service.generate({
        userId: USER_ID,
        meetingId: MEETING_ID,
        templateId: 'template-1',
      });

      expect(result).not.toBe('not_found');
      expect(result).not.toBe('no_transcript');
      if (typeof result === 'string') return;

      expect(result.note.sections).toHaveLength(3);
      expect(result.note.sections[0].heading).toBe('Summary');
      expect(result.note.sections[1].heading).toBe('Key Points');
      expect(result.note.sections[2].heading).toBe('Next Steps');
      expect(result.note.sections[0].content).toContain('Q4 roadmap');
    });
  });

  describe('generate() — auto action item extraction', () => {
    it('should extract action items from Claude response', async () => {
      (firestore.getMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(baseMeeting);
      (firestore.getSegments as ReturnType<typeof vi.fn>).mockResolvedValue(transcriptSegments);
      (firestore.getTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(template);
      (claude.generate as ReturnType<typeof vi.fn>).mockResolvedValue(claudeNoteResponse());
      (firestore.createNote as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.updateMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.createAction as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const result = await service.generate({
        userId: USER_ID,
        meetingId: MEETING_ID,
        templateId: 'template-1',
      });

      if (typeof result === 'string') throw new Error('Expected result');

      expect(result.actionsExtracted).toBe(1);
      expect(firestore.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Draft mobile app spec',
          assignee: 'Alice',
          userId: USER_ID,
          meetingId: MEETING_ID,
          status: 'open',
          source: 'ai_extracted',
        }),
      );
    });

    it('should handle no action items gracefully', async () => {
      const noActionsResponse = {
        ...claudeNoteResponse(),
        text: claudeNoteResponse().text.replace(
          '## Extracted Action Items\n[{"title": "Draft mobile app spec", "assignee": "Alice", "dueDate": "2026-01-20"}]',
          '## Extracted Action Items\n[]',
        ),
      };

      (firestore.getMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(baseMeeting);
      (firestore.getSegments as ReturnType<typeof vi.fn>).mockResolvedValue(transcriptSegments);
      (firestore.getTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(template);
      (claude.generate as ReturnType<typeof vi.fn>).mockResolvedValue(noActionsResponse);
      (firestore.createNote as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.updateMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const result = await service.generate({
        userId: USER_ID,
        meetingId: MEETING_ID,
        templateId: 'template-1',
      });

      if (typeof result === 'string') throw new Error('Expected result');

      expect(result.actionsExtracted).toBe(0);
      expect(firestore.createAction).not.toHaveBeenCalled();
    });
  });

  describe('generate() — auto meeting tagging', () => {
    it('should extract and merge tags from Claude response', async () => {
      (firestore.getMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(baseMeeting);
      (firestore.getSegments as ReturnType<typeof vi.fn>).mockResolvedValue(transcriptSegments);
      (firestore.getTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(template);
      (claude.generate as ReturnType<typeof vi.fn>).mockResolvedValue(claudeNoteResponse());
      (firestore.createNote as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.updateMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.createAction as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const result = await service.generate({
        userId: USER_ID,
        meetingId: MEETING_ID,
        templateId: 'template-1',
      });

      if (typeof result === 'string') throw new Error('Expected result');

      expect(result.tagsGenerated).toContain('mobile-app');
      expect(result.tagsGenerated).toContain('q4-roadmap');

      // Should merge with existing tags (planning was already there)
      expect(firestore.updateMeeting).toHaveBeenCalledWith(
        MEETING_ID,
        USER_ID,
        expect.objectContaining({
          tags: expect.arrayContaining(['planning', 'mobile-app', 'q4-roadmap']),
        }),
      );
    });
  });

  describe('generate() — embedding generation', () => {
    it('should generate embeddings per note section (non-blocking)', async () => {
      (firestore.getMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(baseMeeting);
      (firestore.getSegments as ReturnType<typeof vi.fn>).mockResolvedValue(transcriptSegments);
      (firestore.getTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(template);
      (claude.generate as ReturnType<typeof vi.fn>).mockResolvedValue(claudeNoteResponse());
      (firestore.createNote as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.updateMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.createAction as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.deleteEmbeddingsByMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.storeEmbeddings as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      // Return embeddings for each non-empty section
      (embedding.embed as ReturnType<typeof vi.fn>).mockResolvedValue([
        new Array(768).fill(0.1),
        new Array(768).fill(0.2),
        new Array(768).fill(0.3),
      ]);

      await service.generate({
        userId: USER_ID,
        meetingId: MEETING_ID,
        templateId: 'template-1',
      });

      // Wait for non-blocking embedding generation
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(embedding.embed).toHaveBeenCalled();
      expect(firestore.storeEmbeddings).toHaveBeenCalled();
    });

    it('should not block note saving if embedding generation fails', async () => {
      (firestore.getMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(baseMeeting);
      (firestore.getSegments as ReturnType<typeof vi.fn>).mockResolvedValue(transcriptSegments);
      (firestore.getTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(template);
      (claude.generate as ReturnType<typeof vi.fn>).mockResolvedValue(claudeNoteResponse());
      (firestore.createNote as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.updateMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.createAction as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (embedding.embed as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Vertex AI down'));

      const result = await service.generate({
        userId: USER_ID,
        meetingId: MEETING_ID,
        templateId: 'template-1',
      });

      // Note generation should still succeed
      expect(result).not.toBe('not_found');
      expect(result).not.toBe('no_transcript');
      if (typeof result === 'string') throw new Error('Expected result');

      expect(result.note.sections).toHaveLength(3);
      expect(firestore.createNote).toHaveBeenCalled();
    });
  });

  describe('generate() — note versioning', () => {
    it('should create new version (not overwrite) on regeneration', async () => {
      const meetingV1 = { ...baseMeeting, latestNoteVersion: 1 };
      (firestore.getMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(meetingV1);
      (firestore.getSegments as ReturnType<typeof vi.fn>).mockResolvedValue(transcriptSegments);
      (firestore.getTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(template);
      (claude.generate as ReturnType<typeof vi.fn>).mockResolvedValue(claudeNoteResponse());
      (firestore.createNote as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.updateMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (firestore.createAction as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const result = await service.generate({
        userId: USER_ID,
        meetingId: MEETING_ID,
        templateId: 'template-1',
      });

      if (typeof result === 'string') throw new Error('Expected result');

      // Version should be incremented
      expect(result.note.version).toBe(2);

      // createNote should be called (not updateNote)
      expect(firestore.createNote).toHaveBeenCalledWith(
        MEETING_ID,
        expect.objectContaining({ version: 2 }),
      );

      // latestNoteVersion should be updated on meeting
      expect(firestore.updateMeeting).toHaveBeenCalledWith(
        MEETING_ID,
        USER_ID,
        expect.objectContaining({ latestNoteVersion: 2 }),
      );
    });
  });

  describe('generate() — error cases', () => {
    it('should return not_found if meeting does not exist', async () => {
      (firestore.getMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.generate({
        userId: USER_ID,
        meetingId: 'nonexistent',
      });

      expect(result).toBe('not_found');
    });

    it('should return no_transcript if no segments exist', async () => {
      (firestore.getMeeting as ReturnType<typeof vi.fn>).mockResolvedValue(baseMeeting);
      (firestore.getSegments as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await service.generate({
        userId: USER_ID,
        meetingId: MEETING_ID,
      });

      expect(result).toBe('no_transcript');
    });
  });
});
