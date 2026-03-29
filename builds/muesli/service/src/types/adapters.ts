/**
 * Adapter interfaces for all external dependencies (ADR-005).
 *
 * Every external dependency is accessed through a typed adapter interface.
 * Adapters are injected via Fastify decorator pattern at startup.
 * Tests mock at the adapter boundary.
 *
 * Interface definitions live here; implementations in src/adapters/impl/.
 */

import type {
  Meeting,
  TranscriptSegment,
  MeetingNote,
  Template,
  ActionItem,
  Share,
  User,
  EmbeddingChunk,
  Speaker,
  MeetingStatus,
  ActionItemStatus,
  EmbeddingSource,
  TranscriptionBackend,
} from './domain.js';

// ── Firestore Adapter ────────────────────────────────────────────────

export interface VectorSearchOptions {
  queryVector: number[];
  userId: string;
  limit: number;
  filters?: {
    meetingId?: string;
    sourceType?: EmbeddingSource;
    dateFrom?: Date;
    dateTo?: Date;
  };
}

export interface VectorSearchResult {
  chunk: EmbeddingChunk;
  similarity: number;
}

export interface ListMeetingsOptions {
  userId: string;
  status?: MeetingStatus;
  isStarred?: boolean;
  tag?: string;
  sortBy?: 'createdAt' | 'startedAt' | 'title';
  sortOrder?: 'asc' | 'desc';
  cursor?: string;
  limit?: number;
}

export interface ListActionsOptions {
  userId: string;
  status?: ActionItemStatus;
  assignee?: string;
  meetingId?: string;
  dueBefore?: Date;
  dueAfter?: Date;
  cursor?: string;
  limit?: number;
}

export interface FirestoreAdapter {
  // Users
  getUser(userId: string): Promise<User | null>;
  createUser(user: User): Promise<void>;
  updateUser(userId: string, data: Partial<User>): Promise<void>;
  deleteUser(userId: string): Promise<void>;

  // Meetings
  getMeeting(meetingId: string, userId: string): Promise<Meeting | null>;
  createMeeting(meeting: Meeting): Promise<void>;
  updateMeeting(meetingId: string, userId: string, data: Partial<Meeting>): Promise<void>;
  deleteMeeting(meetingId: string, userId: string): Promise<void>;
  listMeetings(options: ListMeetingsOptions): Promise<{ meetings: Meeting[]; cursor?: string }>;

  // Transcript Segments (subcollection)
  getSegments(meetingId: string, userId: string): Promise<TranscriptSegment[]>;
  batchWriteSegments(meetingId: string, segments: TranscriptSegment[]): Promise<void>;

  // Speakers (subcollection)
  getSpeakers(meetingId: string, userId: string): Promise<Speaker[]>;
  updateSpeaker(meetingId: string, speakerId: string, userId: string, data: Partial<Speaker>): Promise<void>;

  // Meeting Notes (subcollection)
  getNotes(meetingId: string, userId: string): Promise<MeetingNote[]>;
  getNote(meetingId: string, version: number, userId: string): Promise<MeetingNote | null>;
  getLatestNote(meetingId: string, userId: string): Promise<MeetingNote | null>;
  createNote(meetingId: string, note: MeetingNote): Promise<void>;
  updateNote(meetingId: string, version: number, userId: string, data: Partial<MeetingNote>): Promise<void>;

  // Templates
  getTemplate(templateId: string): Promise<Template | null>;
  createTemplate(template: Template): Promise<void>;
  updateTemplate(templateId: string, userId: string, data: Partial<Template>): Promise<void>;
  deleteTemplate(templateId: string, userId: string): Promise<void>;
  listTemplates(userId: string): Promise<Template[]>;

  // Action Items
  getAction(actionId: string, userId: string): Promise<ActionItem | null>;
  createAction(action: ActionItem): Promise<void>;
  updateAction(actionId: string, userId: string, data: Partial<ActionItem>): Promise<void>;
  deleteAction(actionId: string, userId: string): Promise<void>;
  listActions(options: ListActionsOptions): Promise<{ actions: ActionItem[]; cursor?: string }>;

  // Shares
  getShare(shareId: string): Promise<Share | null>;
  createShare(share: Share): Promise<void>;
  deleteShare(shareId: string, userId: string): Promise<void>;
  listSharesByMeeting(meetingId: string, userId: string): Promise<Share[]>;
  incrementShareViewCount(shareId: string): Promise<void>;

  // Embeddings & Vector Search
  storeEmbeddings(chunks: EmbeddingChunk[]): Promise<void>;
  deleteEmbeddingsByMeeting(meetingId: string, userId: string): Promise<void>;
  vectorSearch(options: VectorSearchOptions): Promise<VectorSearchResult[]>;

  // Full-text search (tokenized arrays)
  searchMeetings(userId: string, tokens: string[], cursor?: string, limit?: number): Promise<{ meetings: Meeting[]; cursor?: string }>;
  searchActions(userId: string, tokens: string[], cursor?: string, limit?: number): Promise<{ actions: ActionItem[]; cursor?: string }>;

  // Users — calendar sync
  listConnectedCalendarUsers(): Promise<User[]>;

  // Health
  healthCheck(): Promise<boolean>;

  // Cascade delete (GDPR)
  deleteAllUserData(userId: string): Promise<void>;
}

// ── GCS Adapter ──────────────────────────────────────────────────────

export interface GCSAdapter {
  upload(path: string, data: Buffer, contentType: string): Promise<void>;
  createWriteStream(path: string, contentType: string): NodeJS.WritableStream;
  getSignedUrl(path: string, expirationMinutes?: number): Promise<string>;
  download(path: string): Promise<Buffer>;
  delete(path: string): Promise<void>;
  deleteByPrefix(prefix: string): Promise<void>;
  healthCheck(): Promise<boolean>;
}

// ── Pub/Sub Adapter ──────────────────────────────────────────────────

export interface AudioProcessingMessage {
  meetingId: string;
  userId: string;
  audioPath: string;
  backend?: TranscriptionBackend;
}

export interface PubSubAdapter {
  publish(topic: string, data: AudioProcessingMessage): Promise<string>;
}

// ── Transcription Adapter ────────────────────────────────────────────

export interface TranscribeOptions {
  backend: TranscriptionBackend;
  language?: string;
  enableDiarization?: boolean;
}

export interface TranscriptionResult {
  speaker: string;
  speakerId: string;
  text: string;
  startTime: number;
  endTime: number;
  confidence: number;
}

export interface TranscriptionAdapter {
  transcribe(audio: Buffer, options: TranscribeOptions): Promise<TranscriptionResult[]>;
}

// ── Claude Adapter ───────────────────────────────────────────────────

export interface ClaudeOptions {
  model?: 'sonnet' | 'opus';
  maxTokens?: number;
  temperature?: number;
}

export interface ClaudeResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface ClaudeAdapter {
  generate(prompt: string, options?: ClaudeOptions): Promise<ClaudeResponse>;
}

// ── Embedding Adapter ────────────────────────────────────────────────

export interface EmbeddingAdapter {
  embed(texts: string[]): Promise<number[][]>;
}

// ── Google Calendar Adapter ──────────────────────────────────────────

export interface CalendarEvent {
  eventId: string;
  summary: string;
  start: Date;
  end: Date;
  attendees: { name?: string; email: string }[];
  meetLink?: string;
}

export interface CalendarSyncResult {
  events: CalendarEvent[];
  nextSyncToken?: string;
}

export interface GoogleCalendarAdapter {
  getAuthUrl(userId: string, state: string): string;
  exchangeCode(code: string): Promise<{ accessToken: string; refreshToken: string; expiry: Date }>;
  listEvents(accessToken: string, refreshToken: string, timeMin: Date, timeMax: Date): Promise<CalendarEvent[]>;
  incrementalSync(accessToken: string, refreshToken: string, syncToken: string): Promise<CalendarSyncResult>;
  revokeAccess(accessToken: string): Promise<void>;
}
