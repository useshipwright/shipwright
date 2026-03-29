export * from './domain.js';
export * from './api.js';
export * from './adapters.js';

// ── Service types ───────────────────────────────────────────────────
// Re-export service types for use in composition root and route wiring.

export type { MeetingService } from '../services/meeting.js';
export type { AudioService } from '../services/audio.js';
export type { TemplateService } from '../services/template.js';
export type { ActionService } from '../services/action.js';
export type { SearchService } from '../services/search.js';
export type { AiQaService } from '../services/ai-qa.js';
export type { AiNotesService } from '../services/ai-notes.js';
export type { CalendarService } from '../services/calendar.js';
export type { ShareService } from '../services/share.js';
export type { UserService } from '../services/user.js';
export type { UserNotesService } from '../services/user-notes.js';
export type { AudioProcessorDeps } from '../services/audio-processor.js';
export type { CalendarSyncWorkerDeps } from '../services/calendar-sync-worker.js';
export type { InternalRoutesOptions } from '../routes/internal.js';
