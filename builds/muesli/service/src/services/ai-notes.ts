/**
 * AI note generation service — business logic for generating structured
 * meeting notes from transcript + user notes + template via Claude.
 *
 * Merges transcript segments, user-typed notes, and a selected template
 * into a structured Claude prompt. Parses the response into sections
 * matching the template headings. Auto-extracts action items and tags.
 * Generates embeddings per note section (non-blocking).
 *
 * Prompt injection mitigation: user-provided content (transcript, notes)
 * is clearly delimited from system instructions using XML-style tags.
 *
 * All operations scoped by userId for tenant isolation (IDOR prevention).
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type {
  FirestoreAdapter,
  ClaudeAdapter,
  EmbeddingAdapter,
} from '../types/adapters.js';
import type {
  MeetingNote,
  NoteSection,
  Template,
  ActionItem,
  TranscriptSegment,
  EmbeddingChunk,
} from '../types/domain.js';

// ── Service interface ───────────────────────────────────────────────

export interface AiNotesServiceDeps {
  firestore: FirestoreAdapter;
  claude: ClaudeAdapter;
  embedding: EmbeddingAdapter;
}

export interface GenerateNotesParams {
  userId: string;
  meetingId: string;
  templateId?: string;
  model?: 'sonnet' | 'opus';
}

export interface GenerateNotesResult {
  note: MeetingNote;
  actionsExtracted: number;
  tagsGenerated: string[];
}

// ── Constants ───────────────────────────────────────────────────────

const APPROX_CHARS_PER_TOKEN = 4;

// ── Prompt construction ─────────────────────────────────────────────

function formatTranscript(segments: TranscriptSegment[]): string {
  return segments
    .sort((a, b) => a.startTime - b.startTime)
    .map((s) => {
      const time = formatTimestamp(s.startTime);
      const label = s.isUserNote ? '[User Note]' : s.speaker;
      return `[${time}] ${label}: ${s.text}`;
    })
    .join('\n');
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function truncateTranscript(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const maxChars = maxTokens * APPROX_CHARS_PER_TOKEN;
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  // Truncate at a line boundary
  const truncated = text.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');
  return {
    text: lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated,
    truncated: true,
  };
}

function buildNoteGenerationPrompt(
  template: Template,
  transcript: string,
  userNotes: string,
  meetingTitle: string,
  truncated: boolean,
): string {
  const sectionInstructions = template.sections
    .map((s, i) => `${i + 1}. **${s.heading}**: ${s.prompt}`)
    .join('\n');

  const truncationWarning = truncated
    ? '\n\nNote: The transcript was truncated due to length. Work with the available content.'
    : '';

  return `You are a meeting intelligence assistant. Generate structured meeting notes from the transcript and user notes below.

## Instructions

For each section listed below, extract the relevant information from the transcript and user notes.
Output your response as a series of sections, each starting with the section heading on its own line prefixed with "## ", followed by the content.

User notes (marked [User Note] in the transcript) are high-priority anchors — give them extra weight when generating notes.

After all template sections, add two additional sections:
1. "## Extracted Action Items" — List action items as a JSON array: [{"title": "...", "assignee": "...", "dueDate": "..."}]. Only include fields that are explicitly mentioned. If no action items found, output an empty array [].
2. "## Auto Tags" — List 1-5 short tags (lowercase, no #) relevant to the meeting content, as a JSON array of strings. Example: ["product-review", "q4-planning"]

## Meeting Title
${meetingTitle}

## Sections to Generate
${sectionInstructions}

<transcript>
${transcript}
</transcript>

<user_notes>
${userNotes || '(No user notes provided)'}
</user_notes>${truncationWarning}`;
}

// ── Response parsing ────────────────────────────────────────────────

function parseSections(text: string, template: Template): NoteSection[] {
  const sections: NoteSection[] = [];
  const lines = text.split('\n');

  let currentHeading: string | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      if (currentHeading !== null) {
        sections.push({
          heading: currentHeading,
          content: currentContent.join('\n').trim(),
        });
      }
      currentHeading = headingMatch[1].trim();
      currentContent = [];
    } else if (currentHeading !== null) {
      currentContent.push(line);
    }
  }

  // Push the last section
  if (currentHeading !== null) {
    sections.push({
      heading: currentHeading,
      content: currentContent.join('\n').trim(),
    });
  }

  // Filter to only the template section headings (preserve order from template)
  const templateSections: NoteSection[] = [];
  for (const ts of template.sections) {
    const found = sections.find(
      (s) => s.heading.toLowerCase() === ts.heading.toLowerCase(),
    );
    templateSections.push({
      heading: ts.heading,
      content: found?.content ?? '',
    });
  }

  return templateSections;
}

function parseActionItems(text: string): { title: string; assignee?: string; dueDate?: string }[] {
  const section = extractSection(text, 'Extracted Action Items');
  if (!section) return [];

  // Find JSON array in the section content
  const match = section.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const items = JSON.parse(match[0]) as { title: string; assignee?: string; dueDate?: string }[];
    if (!Array.isArray(items)) return [];
    return items.filter((item) => item && typeof item.title === 'string' && item.title.length > 0);
  } catch {
    return [];
  }
}

function parseTags(text: string): string[] {
  const section = extractSection(text, 'Auto Tags');
  if (!section) return [];

  const match = section.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const tags = JSON.parse(match[0]) as string[];
    if (!Array.isArray(tags)) return [];
    return tags
      .filter((t) => typeof t === 'string' && t.length > 0)
      .map((t) => t.toLowerCase().trim())
      .slice(0, 5);
  } catch {
    return [];
  }
}

function extractSection(text: string, heading: string): string | null {
  const lines = text.split('\n');
  let capturing = false;
  const content: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      if (capturing) break;
      if (headingMatch[1].trim().toLowerCase() === heading.toLowerCase()) {
        capturing = true;
      }
    } else if (capturing) {
      content.push(line);
    }
  }

  return capturing ? content.join('\n').trim() : null;
}

// ── Tokenize for search ─────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// ── Service factory ─────────────────────────────────────────────────

export function createAiNotesService(deps: AiNotesServiceDeps) {
  const { firestore, claude, embedding } = deps;

  return {
    /**
     * Generate structured meeting notes from transcript + user notes + template.
     * Creates a new version in the notes subcollection. Auto-extracts action
     * items and generates tags. Embeddings are generated non-blocking.
     */
    async generate(params: GenerateNotesParams): Promise<GenerateNotesResult | 'not_found' | 'no_transcript'> {
      const { userId, meetingId, model } = params;

      // Verify meeting ownership
      const meeting = await firestore.getMeeting(meetingId, userId);
      if (!meeting) return 'not_found';

      // Fetch transcript segments
      const segments = await firestore.getSegments(meetingId, userId);
      if (segments.length === 0) return 'no_transcript';

      // Resolve template: override → user default → first system template
      let template: Template | null = null;
      if (params.templateId) {
        template = await firestore.getTemplate(params.templateId);
      }
      if (!template) {
        // Try user default
        const user = await firestore.getUser(userId);
        if (user?.defaultTemplateId) {
          template = await firestore.getTemplate(user.defaultTemplateId);
        }
      }
      if (!template) {
        // Fall back to system templates
        const templates = await firestore.listTemplates(userId);
        template = templates.find((t) => t.isSystem && t.name === 'General') ?? templates.find((t) => t.isSystem) ?? null;
      }
      if (!template) {
        // Last resort: inline default
        template = {
          id: 'default',
          name: 'General',
          isSystem: true,
          sections: [
            { heading: 'Summary', prompt: 'Provide a concise summary of the meeting.' },
            { heading: 'Key Points', prompt: 'List the main discussion points.' },
            { heading: 'Action Items', prompt: 'Extract action items with assignees.' },
          ],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }

      // Separate transcript segments and user notes
      const transcriptSegments = segments.filter((s) => !s.isUserNote);
      const userNoteSegments = segments.filter((s) => s.isUserNote);

      const transcriptText = formatTranscript(transcriptSegments);
      const userNotesText = userNoteSegments
        .sort((a, b) => a.startTime - b.startTime)
        .map((s) => `[${formatTimestamp(s.startTime)}] ${s.text}`)
        .join('\n');

      // Truncate transcript if it exceeds the configured token limit
      const { text: finalTranscript, truncated } = truncateTranscript(
        transcriptText,
        config.maxTranscriptTokens,
      );

      // Build prompt with clear delimiters for user content
      const prompt = buildNoteGenerationPrompt(
        template,
        finalTranscript,
        userNotesText,
        meeting.title,
        truncated,
      );

      // Call Claude
      const response = await claude.generate(prompt, {
        model: model ?? 'sonnet',
        maxTokens: 4096,
        temperature: 0.3,
      });

      // Parse structured sections from response
      const sections = parseSections(response.text, template);

      // Create new note version
      const newVersion = meeting.latestNoteVersion + 1;
      const note: MeetingNote = {
        version: newVersion,
        templateId: template.id,
        sections,
        isEdited: false,
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        generationLatencyMs: response.latencyMs,
        generatedAt: new Date(),
      };

      await firestore.createNote(meetingId, note);
      await firestore.updateMeeting(meetingId, userId, {
        latestNoteVersion: newVersion,
        updatedAt: new Date(),
      });

      // Extract action items from Claude response
      const rawActions = parseActionItems(response.text);
      let actionsExtracted = 0;

      for (const raw of rawActions) {
        const now = new Date();
        const action: ActionItem = {
          id: crypto.randomUUID(),
          userId,
          meetingId,
          title: raw.title,
          text: raw.title,
          assignee: raw.assignee,
          dueDate: raw.dueDate && !isNaN(new Date(raw.dueDate).getTime()) ? new Date(raw.dueDate) : undefined,
          status: 'open',
          source: 'ai_extracted',
          sourceMeetingId: meetingId,
          searchTokens: tokenize(raw.title),
          createdAt: now,
          updatedAt: now,
        };
        await firestore.createAction(action);
        actionsExtracted++;
      }

      // Auto-generate tags and update meeting
      const tags = parseTags(response.text);
      if (tags.length > 0) {
        // Merge with existing tags, dedup
        const existingTags = new Set(meeting.tags);
        const newTags = tags.filter((t) => !existingTags.has(t));
        if (newTags.length > 0) {
          const merged = [...meeting.tags, ...newTags];
          await firestore.updateMeeting(meetingId, userId, {
            tags: merged,
            searchTokens: [
              ...new Set([
                ...meeting.searchTokens,
                ...newTags.flatMap((t) => tokenize(t)),
              ]),
            ],
            updatedAt: new Date(),
          });
        }
      }

      // Generate embeddings per note section (non-blocking)
      generateEmbeddings(
        embedding,
        firestore,
        meetingId,
        userId,
        meeting.title,
        meeting.createdAt,
        sections,
      ).catch((err) => {
        logger.warn(
          { err, meetingId },
          'Non-blocking embedding generation failed — semantic search may be degraded',
        );
      });

      return { note, actionsExtracted, tagsGenerated: tags };
    },
  };
}

export type AiNotesService = ReturnType<typeof createAiNotesService>;

// ── Non-blocking embedding generation ───────────────────────────────

async function generateEmbeddings(
  embedding: EmbeddingAdapter,
  firestore: FirestoreAdapter,
  meetingId: string,
  userId: string,
  meetingTitle: string,
  meetingDate: Date,
  sections: NoteSection[],
): Promise<void> {
  const textsToEmbed = sections
    .filter((s) => s.content.length > 0)
    .map((s) => `${s.heading}\n\n${s.content}`);

  if (textsToEmbed.length === 0) return;

  const vectors = await embedding.embed(textsToEmbed);

  const chunks: EmbeddingChunk[] = [];
  let idx = 0;
  for (const section of sections) {
    if (section.content.length === 0) continue;

    chunks.push({
      id: crypto.randomUUID(),
      meetingId,
      userId,
      source: 'notes',
      sectionHeading: section.heading,
      text: `${section.heading}\n\n${section.content}`,
      embedding: vectors[idx],
      meetingTitle,
      meetingDate,
      createdAt: new Date(),
    });
    idx++;
  }

  // Delete old embeddings for this meeting's notes before storing new ones
  await firestore.deleteEmbeddingsByMeeting(meetingId, userId);
  await firestore.storeEmbeddings(chunks);

  logger.info(
    { meetingId, chunkCount: chunks.length },
    'Note embeddings stored',
  );
}
