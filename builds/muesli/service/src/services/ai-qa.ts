/**
 * AI Q&A service — cross-meeting RAG pipeline and meeting prep brief generation.
 *
 * Q&A flow:
 *   1. Embed the user's question via Embedding Adapter
 *   2. Retrieve top-20 relevant chunks via Firestore vector search (scoped to userId)
 *   3. Build a Claude prompt with clearly delimited retrieved context
 *   4. Return answer with meeting citations
 *
 * Meeting prep flow:
 *   1. Find past meetings with overlapping attendees (scoped to userId)
 *   2. Retrieve latest notes from those meetings
 *   3. Generate a prep brief via Claude
 *
 * SECURITY:
 * - All Firestore queries include userId filter (IDOR mitigation)
 * - Prompt construction clearly delimits user content (prompt injection mitigation)
 * - No secrets, API keys, or internal URLs are included in prompts
 */

import type { ClaudeAdapter, ClaudeResponse } from '../types/adapters.js';
import type { EmbeddingAdapter } from '../types/adapters.js';
import type { FirestoreAdapter, VectorSearchResult } from '../types/adapters.js';
import type { Meeting, MeetingNote } from '../types/domain.js';
import { logger } from '../logger.js';

// ── Types ────────────────────────────────────────────────────────────

export interface AiQaServiceDeps {
  firestoreAdapter: FirestoreAdapter;
  embeddingAdapter: EmbeddingAdapter;
  claudeAdapter: ClaudeAdapter;
}

export interface AskQuestionParams {
  question: string;
  userId: string;
}

export interface MeetingCitation {
  meetingId: string;
  meetingTitle: string;
  meetingDate: Date;
  sectionHeading?: string;
  text: string;
}

export interface AskQuestionResult {
  answer: string;
  citations: MeetingCitation[];
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface MeetingPrepParams {
  userId: string;
  meetingId?: string;
  attendeeEmails?: string[];
}

export interface MeetingPrepResult {
  brief: string;
  meetings: Array<{ id: string; title: string; date: Date }>;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// ── Constants ────────────────────────────────────────────────────────

const TOP_K_CHUNKS = 20;
const MAX_CONTEXT_CHARS = 50_000;
const MAX_PREP_MEETINGS = 10;

// ── Prompt builders ──────────────────────────────────────────────────

function buildQaPrompt(question: string, chunks: VectorSearchResult[]): string {
  let contextBlock = '';
  let totalChars = 0;

  for (const result of chunks) {
    const chunk = result.chunk;
    const entry = [
      `<context_chunk meeting_id="${chunk.meetingId}" meeting_title="${chunk.meetingTitle}" date="${chunk.meetingDate.toISOString()}"${chunk.sectionHeading ? ` section="${chunk.sectionHeading}"` : ''}>`,
      chunk.text,
      '</context_chunk>',
    ].join('\n');

    if (totalChars + entry.length > MAX_CONTEXT_CHARS) break;
    contextBlock += entry + '\n\n';
    totalChars += entry.length;
  }

  return [
    'You are a meeting intelligence assistant. Answer the user\'s question based ONLY on the meeting context provided below. If the context does not contain enough information to answer, say so clearly.',
    '',
    'Rules:',
    '- Cite specific meetings by their title and date when referencing information.',
    '- Do not fabricate information not present in the context.',
    '- Be concise and direct.',
    '',
    '<retrieved_context>',
    contextBlock.trim(),
    '</retrieved_context>',
    '',
    '<user_question>',
    question,
    '</user_question>',
  ].join('\n');
}

function buildPrepPrompt(
  meetings: Array<{ meeting: Meeting; notes: MeetingNote | null }>,
): string {
  let contextBlock = '';

  for (const { meeting, notes } of meetings) {
    const attendeeList = meeting.attendees
      .map((a) => a.name)
      .join(', ');

    const notesContent = notes
      ? notes.sections.map((s) => `### ${s.heading}\n${s.content}`).join('\n\n')
      : '(No notes available)';

    contextBlock += [
      `<past_meeting title="${meeting.title}" date="${meeting.createdAt.toISOString()}" attendees="${attendeeList}">`,
      notesContent,
      '</past_meeting>',
      '',
    ].join('\n');
  }

  return [
    'You are a meeting intelligence assistant preparing a brief for an upcoming meeting. Based on the past meeting notes below, generate a concise prep brief that includes:',
    '',
    '1. Key topics and decisions from past meetings with these attendees',
    '2. Open action items or unresolved issues',
    '3. Important context the user should know going into the meeting',
    '',
    'Rules:',
    '- Only reference information from the provided meeting context.',
    '- Be concise and actionable.',
    '- Organize by topic, not by meeting.',
    '',
    '<past_meetings>',
    contextBlock.trim(),
    '</past_meetings>',
  ].join('\n');
}

// ── Service ──────────────────────────────────────────────────────────

export type AiQaService = ReturnType<typeof createAiQaService>;

export function createAiQaService(deps: AiQaServiceDeps) {
  const { firestoreAdapter, embeddingAdapter, claudeAdapter } = deps;

  return {
    /**
     * Cross-meeting Q&A via RAG pipeline.
     *
     * SECURITY: vectorSearch is scoped to userId to prevent cross-user data leakage.
     */
    async askQuestion(params: AskQuestionParams): Promise<AskQuestionResult> {
      const { question, userId } = params;

      // 1. Embed the question
      const [queryVector] = await embeddingAdapter.embed([question]);

      // 2. Retrieve top-K chunks scoped to this user
      const searchResults = await firestoreAdapter.vectorSearch({
        queryVector,
        userId,
        limit: TOP_K_CHUNKS,
      });

      if (searchResults.length === 0) {
        return {
          answer: 'I could not find any relevant meeting content to answer your question. Try asking about topics discussed in your past meetings.',
          citations: [],
          model: '',
          inputTokens: 0,
          outputTokens: 0,
        };
      }

      // 3. Build prompt with cited context
      const prompt = buildQaPrompt(question, searchResults);

      // 4. Generate answer via Claude
      let response: ClaudeResponse;
      try {
        response = await claudeAdapter.generate(prompt, { model: 'sonnet' });
      } catch (err) {
        logger.error({ err, userId }, 'Claude API failed during Q&A');
        throw err;
      }

      // 5. Build citations from the chunks used
      const citations: MeetingCitation[] = searchResults.map((r) => ({
        meetingId: r.chunk.meetingId,
        meetingTitle: r.chunk.meetingTitle,
        meetingDate: r.chunk.meetingDate,
        sectionHeading: r.chunk.sectionHeading,
        text: r.chunk.text,
      }));

      return {
        answer: response.text,
        citations,
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      };
    },

    /**
     * Generate meeting prep brief from past meetings with overlapping attendees.
     *
     * SECURITY: All meeting queries are scoped to userId.
     */
    async meetingPrep(params: MeetingPrepParams): Promise<MeetingPrepResult> {
      const { userId, meetingId, attendeeEmails } = params;

      // Collect attendee emails to search for
      let targetEmails: string[] = attendeeEmails ?? [];

      // If meetingId is provided, get attendees from that meeting
      if (meetingId) {
        const meeting = await firestoreAdapter.getMeeting(meetingId, userId);
        if (!meeting) {
          throw Object.assign(new Error('Meeting not found'), { statusCode: 404 });
        }
        const meetingEmails = meeting.attendees
          .map((a) => a.email)
          .filter((e): e is string => !!e);
        targetEmails = [...new Set([...targetEmails, ...meetingEmails])];
      }

      if (targetEmails.length === 0) {
        throw Object.assign(
          new Error('Must provide meetingId with attendees or attendeeEmails'),
          { statusCode: 400 },
        );
      }

      // Find past meetings with overlapping attendees, scoped to userId
      const { meetings: allMeetings } = await firestoreAdapter.listMeetings({
        userId,
        limit: 100,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });

      // Filter to meetings that have at least one overlapping attendee email
      const relevantMeetings = allMeetings
        .filter((m) => {
          // Exclude the source meeting if provided
          if (meetingId && m.id === meetingId) return false;
          return m.attendees.some(
            (a) => a.email && targetEmails.includes(a.email),
          );
        })
        .slice(0, MAX_PREP_MEETINGS);

      if (relevantMeetings.length === 0) {
        return {
          brief: 'No past meetings found with overlapping attendees.',
          meetings: [],
          model: '',
          inputTokens: 0,
          outputTokens: 0,
        };
      }

      // Get latest notes for each relevant meeting
      const meetingsWithNotes = await Promise.all(
        relevantMeetings.map(async (meeting) => {
          const notes = await firestoreAdapter.getLatestNote(meeting.id, userId);
          return { meeting, notes };
        }),
      );

      // Build prompt and generate
      const prompt = buildPrepPrompt(meetingsWithNotes);

      let response: ClaudeResponse;
      try {
        response = await claudeAdapter.generate(prompt, { model: 'sonnet' });
      } catch (err) {
        logger.error({ err, userId }, 'Claude API failed during meeting prep');
        throw err;
      }

      return {
        brief: response.text,
        meetings: relevantMeetings.map((m) => ({
          id: m.id,
          title: m.title,
          date: m.createdAt,
        })),
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      };
    },
  };
}
