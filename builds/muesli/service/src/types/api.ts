/**
 * API request/response schemas using Zod.
 *
 * All responses follow the standard envelope (ADR-007):
 *   Success: { data: T, meta?: { cursor?, hasMore?, warning? } }
 *   Error:   { error: { code: number, message: string, details?: object } }
 */

import { z } from 'zod';

// ── Response Envelope ────────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
  meta?: {
    cursor?: string;
    hasMore?: boolean;
    warning?: string;
  };
}

export interface ApiErrorResponse {
  error: {
    code: number;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ── Pagination ───────────────────────────────────────────────────────

export const PaginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

// ── Meeting Schemas ──────────────────────────────────────────────────

export const CreateMeetingBodySchema = z.object({
  title: z.string().min(1).max(500),
  attendees: z
    .array(
      z.object({
        name: z.string().min(1),
        email: z.string().email().optional(),
      }),
    )
    .default([]),
  tags: z.array(z.string().min(1).max(100)).default([]),
  calendarEventId: z.string().optional(),
});

export type CreateMeetingBody = z.infer<typeof CreateMeetingBodySchema>;

export const UpdateMeetingBodySchema = z.object({
  title: z.string().min(1).max(500).optional(),
  attendees: z
    .array(
      z.object({
        name: z.string().min(1),
        email: z.string().email().optional(),
      }),
    )
    .optional(),
  tags: z.array(z.string().min(1).max(100)).optional(),
  isStarred: z.boolean().optional(),
});

export type UpdateMeetingBody = z.infer<typeof UpdateMeetingBodySchema>;

export const ListMeetingsQuerySchema = PaginationQuerySchema.extend({
  status: z.enum(['recording', 'processing', 'ready', 'failed']).optional(),
  isStarred: z.coerce.boolean().optional(),
  tag: z.string().optional(),
  sortBy: z.enum(['createdAt', 'startedAt', 'title']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type ListMeetingsQuery = z.infer<typeof ListMeetingsQuerySchema>;

// ── Transcript Schemas ───────────────────────────────────────────────

export const TranscriptQuerySchema = PaginationQuerySchema.extend({
  speakerId: z.string().optional(),
  startTime: z.coerce.number().min(0).optional(),
  endTime: z.coerce.number().min(0).optional(),
});

export type TranscriptQuery = z.infer<typeof TranscriptQuerySchema>;

// ── Speaker Schemas ──────────────────────────────────────────────────

export const UpdateSpeakerBodySchema = z.object({
  resolvedName: z.string().min(1).max(200).optional(),
  resolvedEmail: z.string().email().optional(),
});

export type UpdateSpeakerBody = z.infer<typeof UpdateSpeakerBodySchema>;

// ── Note Schemas ─────────────────────────────────────────────────────

export const GenerateNotesBodySchema = z.object({
  templateId: z.string().optional(),
});

export type GenerateNotesBody = z.infer<typeof GenerateNotesBodySchema>;

export const EditNoteBodySchema = z.object({
  sections: z.array(
    z.object({
      heading: z.string().min(1),
      content: z.string(),
    }),
  ),
});

export type EditNoteBody = z.infer<typeof EditNoteBodySchema>;

// ── User Notes Schemas ───────────────────────────────────────────────

export const CreateUserNoteBodySchema = z.object({
  text: z.string().min(1).max(10_000),
  timestamp: z.number().min(0).optional(),
});

export type CreateUserNoteBody = z.infer<typeof CreateUserNoteBodySchema>;

// ── Template Schemas ─────────────────────────────────────────────────

export const CreateTemplateBodySchema = z.object({
  name: z.string().min(1).max(200),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(200),
        prompt: z.string().min(1).max(2000),
      }),
    )
    .min(1),
});

export type CreateTemplateBody = z.infer<typeof CreateTemplateBodySchema>;

export const UpdateTemplateBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(200),
        prompt: z.string().min(1).max(2000),
      }),
    )
    .min(1)
    .optional(),
});

export type UpdateTemplateBody = z.infer<typeof UpdateTemplateBodySchema>;

// ── Action Item Schemas ──────────────────────────────────────────────

export const CreateActionBodySchema = z.object({
  title: z.string().min(1).max(500),
  meetingId: z.string().optional(),
  assignee: z.string().max(200).optional(),
  dueDate: z.coerce.date().optional(),
  status: z.enum(['open', 'in_progress', 'completed', 'cancelled']).default('open'),
});

export type CreateActionBody = z.infer<typeof CreateActionBodySchema>;

export const UpdateActionBodySchema = z.object({
  title: z.string().min(1).max(500).optional(),
  assignee: z.string().max(200).optional(),
  dueDate: z.coerce.date().optional(),
  status: z.enum(['open', 'in_progress', 'completed', 'cancelled']).optional(),
});

export type UpdateActionBody = z.infer<typeof UpdateActionBodySchema>;

export const ListActionsQuerySchema = PaginationQuerySchema.extend({
  status: z.enum(['open', 'in_progress', 'completed', 'cancelled']).optional(),
  assignee: z.string().optional(),
  meetingId: z.string().optional(),
  dueBefore: z.coerce.date().optional(),
  dueAfter: z.coerce.date().optional(),
});

export type ListActionsQuery = z.infer<typeof ListActionsQuerySchema>;

// ── Search Schemas ───────────────────────────────────────────────────

export const SearchQuerySchema = PaginationQuerySchema.extend({
  q: z.string().min(1).max(500),
  type: z.enum(['meetings', 'transcripts', 'notes', 'actions']).optional(),
});

export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const SemanticSearchQuerySchema = PaginationQuerySchema.extend({
  q: z.string().min(1).max(500),
  meetingId: z.string().optional(),
  source: z.enum(['notes', 'transcript']).optional(),
});

export type SemanticSearchQuery = z.infer<typeof SemanticSearchQuerySchema>;

// ── AI Schemas ───────────────────────────────────────────────────────

export const AiAskBodySchema = z.object({
  question: z.string().min(1).max(2000),
});

export type AiAskBody = z.infer<typeof AiAskBodySchema>;

export const AiMeetingPrepBodySchema = z.object({
  meetingId: z.string().min(1),
  attendeeEmails: z.array(z.string().email()).optional(),
});

export type AiMeetingPrepBody = z.infer<typeof AiMeetingPrepBodySchema>;

// ── Share Schemas ────────────────────────────────────────────────────

export const CreateShareBodySchema = z.object({
  access: z.enum(['public', 'authenticated', 'specific_emails']),
  allowedEmails: z.array(z.string().email()).optional(),
  includeTranscript: z.boolean().default(false),
  includeAudio: z.boolean().default(false),
  expiresAt: z.coerce.date().optional(),
});

export type CreateShareBody = z.infer<typeof CreateShareBodySchema>;

// ── Calendar Schemas ─────────────────────────────────────────────────

export const CalendarEventsQuerySchema = z.object({
  timeMin: z.coerce.date(),
  timeMax: z.coerce.date(),
});

export type CalendarEventsQuery = z.infer<typeof CalendarEventsQuerySchema>;

// ── User Profile Schemas ─────────────────────────────────────────────

export const UpdateUserBodySchema = z.object({
  displayName: z.string().max(200).optional(),
  defaultTemplateId: z.string().optional(),
  transcriptionBackend: z.enum(['deepgram', 'whisper', 'google-stt']).optional(),
  autoTranscribe: z.boolean().optional(),
  timezone: z.string().max(100).optional(),
  language: z.string().regex(/^[a-z]{2}$/).optional(),
});

export type UpdateUserBody = z.infer<typeof UpdateUserBodySchema>;

// ── Audio Upload Schemas ─────────────────────────────────────────────

export const AudioUploadQuerySchema = z.object({
  backend: z.enum(['deepgram', 'whisper', 'google-stt']).optional(),
});

export type AudioUploadQuery = z.infer<typeof AudioUploadQuerySchema>;

// ── ID Param Schema ──────────────────────────────────────────────────

export const IdParamSchema = z.object({
  id: z.string().min(1),
});

export type IdParam = z.infer<typeof IdParamSchema>;

export const MeetingIdParamSchema = z.object({
  id: z.string().min(1),
});

export const ShareIdParamSchema = z.object({
  shareId: z.string().min(1),
});

export const SpeakerIdParamSchema = z.object({
  id: z.string().min(1),
  speakerId: z.string().min(1),
});

export const NoteVersionParamSchema = z.object({
  id: z.string().min(1),
  version: z.coerce.number().int().min(1),
});
