import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { registerPlugins } from './plugins/index.js';
import { registerRoutes } from './routes/index.js';

// Adapter types (ADR-005)
import type { FirestoreAdapter, GCSAdapter } from './types/adapters.js';

// Service types
import type { MeetingService } from './services/meeting.js';
import type { TemplateService } from './services/template.js';
import type { AudioService } from './services/audio.js';
import type { UserNotesService } from './services/user-notes.js';
import type { AiNotesService } from './services/ai-notes.js';
import type { ActionService } from './services/action.js';
import type { SearchService } from './services/search.js';
import type { AiQaService } from './services/ai-qa.js';
import type { CalendarService } from './services/calendar.js';
import type { ShareService } from './services/share.js';
import type { UserService } from './services/user.js';
import type { AudioProcessorDeps } from './services/audio-processor.js';
import type { CalendarSyncWorkerDeps } from './services/calendar-sync-worker.js';

export interface AppDependencies {
  // Adapters (exposed directly for plugins that need them)
  firestore: FirestoreAdapter;
  gcs: GCSAdapter;

  // Services
  meetingService: MeetingService;
  templateService: TemplateService;
  audioService: AudioService;
  userNotesService: UserNotesService;
  aiNotesService: AiNotesService;
  actionService: ActionService;
  searchService: SearchService;
  aiQaService: AiQaService;
  calendarService: CalendarService;
  shareService: ShareService;
  userService: UserService;

  // Processor / worker deps
  audioProcessorDeps: AudioProcessorDeps;
  calendarSyncWorkerDeps: CalendarSyncWorkerDeps;
}

export async function buildApp(deps: Partial<AppDependencies> = {}): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: config.trustProxy,
    logger: {
      level: config.logLevel,
      redact: {
        paths: ['req.headers.authorization', '*.password', '*.token', '*.secret'],
        censor: '[REDACTED]',
      },
    },
  });

  await registerPlugins(app);
  await registerRoutes(app, deps);

  return app;
}
