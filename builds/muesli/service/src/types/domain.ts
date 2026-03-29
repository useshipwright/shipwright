/**
 * Domain types for Muesli meeting intelligence API.
 *
 * These types map to the Firestore data model defined in the PRD.
 * All entities that belong to a user include a userId field for tenant isolation.
 */

// ── Meeting ──────────────────────────────────────────────────────────

export type MeetingStatus = 'recording' | 'processing' | 'ready' | 'failed';

export interface Attendee {
  name: string;
  email?: string;
}

export interface SpeakerStats {
  [speakerId: string]: {
    talkTimeSeconds: number;
    segmentCount: number;
  };
}

export interface Meeting {
  id: string;
  userId: string;
  title: string;
  status: MeetingStatus;
  error?: string;
  startedAt?: Date;
  endedAt?: Date;
  durationSeconds?: number;
  attendees: Attendee[];
  tags: string[];
  isStarred: boolean;
  calendarEventId?: string;
  audioPath?: string;
  latestNoteVersion: number;
  speakerStats?: SpeakerStats;
  searchTokens: string[];
  createdAt: Date;
  updatedAt: Date;
}

// ── Transcript Segment ───────────────────────────────────────────────

export type AudioChannel = 'system_audio' | 'microphone' | 'user_input';

export interface TranscriptSegment {
  id: string;
  speaker: string;
  speakerId: string;
  text: string;
  startTime: number;
  endTime: number;
  confidence?: number;
  channel: AudioChannel;
  isUserNote: boolean;
  searchTokens: string[];
}

// ── Speaker ──────────────────────────────────────────────────────────

export interface Speaker {
  id: string;
  label: string;
  resolvedName?: string;
  resolvedEmail?: string;
}

// ── Meeting Note ─────────────────────────────────────────────────────

export interface NoteSection {
  heading: string;
  content: string;
}

export interface MeetingNote {
  version: number;
  templateId: string;
  sections: NoteSection[];
  isEdited: boolean;
  model: string;
  inputTokens: number;
  outputTokens: number;
  generationLatencyMs: number;
  generatedAt: Date;
}

// ── Template ─────────────────────────────────────────────────────────

export interface TemplateSection {
  heading: string;
  prompt: string;
}

export interface Template {
  id: string;
  name: string;
  isSystem: boolean;
  userId?: string;
  sections: TemplateSection[];
  createdAt: Date;
  updatedAt: Date;
}

// ── Action Item ──────────────────────────────────────────────────────

export type ActionItemStatus = 'open' | 'in_progress' | 'completed' | 'cancelled';
export type ActionItemSource = 'ai_extracted' | 'manual';

export interface ActionItem {
  id: string;
  userId: string;
  meetingId?: string;
  title: string;
  text: string;
  assignee?: string;
  dueDate?: Date;
  status: ActionItemStatus;
  source: ActionItemSource;
  sourceMeetingId?: string;
  linkedSegmentId?: string;
  searchTokens: string[];
  createdAt: Date;
  updatedAt: Date;
}

// ── Share ─────────────────────────────────────────────────────────────

export type ShareAccessMode = 'public' | 'authenticated' | 'specific_emails';

export interface Share {
  shareId: string;
  meetingId: string;
  userId: string;
  accessMode: ShareAccessMode;
  allowedEmails?: string[];
  includeTranscript: boolean;
  includeAudio: boolean;
  expiresAt?: Date;
  viewCount: number;
  createdAt: Date;
}

// ── User ──────────────────────────────────────────────────────────────

export type TranscriptionBackend = 'deepgram' | 'whisper' | 'google-stt';

export interface CalendarTokens {
  accessToken: string;
  refreshToken: string;
  expiry: Date;
}

export interface User {
  id: string;
  email: string;
  displayName?: string;
  defaultTemplateId?: string;
  transcriptionBackend: TranscriptionBackend;
  autoTranscribe: boolean;
  timezone: string;
  language: string;
  calendarConnected: boolean;
  calendarTokens?: CalendarTokens;
  calendarSyncToken?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ── Embedding Chunk ──────────────────────────────────────────────────

export type EmbeddingSource = 'notes' | 'transcript';

export interface EmbeddingChunk {
  id: string;
  meetingId: string;
  userId: string;
  source: EmbeddingSource;
  sectionHeading?: string;
  text: string;
  embedding: number[];
  meetingTitle: string;
  meetingDate: Date;
  speaker?: string;
  createdAt: Date;
}
