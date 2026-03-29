/**
 * Composition root — constructs all adapter and service singletons.
 *
 * ADR-005: Every external dependency is accessed through a typed adapter
 * interface, injected via the composition root. Tests mock at the adapter
 * boundary.
 */

import { config } from './config.js';
import { logger } from './logger.js';

// Adapters
import {
  createFirestoreAdapter,
  createGCSAdapter,
  createPubSubAdapter,
  createClaudeAdapter,
  createEmbeddingAdapter,
  createTranscriptionAdapter,
} from './adapters/index.js';
import { createGoogleCalendarAdapter } from './adapters/google-calendar.js';

// Services
import { createMeetingService } from './services/meeting.js';
import { createTemplateService } from './services/template.js';
import { createAudioService } from './services/audio.js';
import { createUserNotesService } from './services/user-notes.js';
import { createAiNotesService } from './services/ai-notes.js';
import { createActionService } from './services/action.js';
import { createSearchService } from './services/search.js';
import { createAiQaService } from './services/ai-qa.js';
import { createCalendarService } from './services/calendar.js';
import { createShareService } from './services/share.js';
import { createUserService } from './services/user.js';

// Utilities
import { TokenEncryptor } from './utils/crypto.js';

// Types
import type { AppDependencies } from './app.js';

export function createDependencies(): AppDependencies {
  logger.info('Constructing adapter singletons');

  // ── Adapters ────────────────────────────────────────────────────────

  const firestore = createFirestoreAdapter(config.firebaseServiceAccount);
  const gcs = createGCSAdapter();
  const pubsub = createPubSubAdapter();
  const claude = createClaudeAdapter();
  const embedding = createEmbeddingAdapter();

  const googleCalendar = createGoogleCalendarAdapter({
    clientId: config.googleCalendarClientId,
    clientSecret: config.googleCalendarClientSecret,
    redirectUri: config.googleCalendarRedirectUri,
  });

  const tokenEncryptor = new TokenEncryptor(
    config.googleCloudProject,
    config.tokenEncryptionSecretId,
  );

  // ── Services ────────────────────────────────────────────────────────

  logger.info('Constructing service singletons');

  const meetingService = createMeetingService({ firestore });
  const templateService = createTemplateService({ firestore });
  const audioService = createAudioService({ firestore, gcs, pubsub });
  const userNotesService = createUserNotesService({ firestore });
  const aiNotesService = createAiNotesService({ firestore, claude, embedding });
  const actionService = createActionService({ firestore });
  const searchService = createSearchService({
    firestoreAdapter: firestore,
    embeddingAdapter: embedding,
  });
  const aiQaService = createAiQaService({
    firestoreAdapter: firestore,
    embeddingAdapter: embedding,
    claudeAdapter: claude,
  });
  const calendarService = createCalendarService({
    firestoreAdapter: firestore,
    calendarAdapter: googleCalendar,
    tokenEncryptor,
    hmacSecret: config.calendarHmacSecret,
  });
  const shareService = createShareService({ firestore, gcs });
  const userService = createUserService({ firestore, gcs });

  // ── Audio processor deps (not a service singleton — used per-request) ──

  const audioProcessorDeps = {
    firestore,
    gcs,
    createTranscriptionAdapter,
    generateNotes: async (params: { userId: string; meetingId: string }) => {
      return aiNotesService.generate({
        userId: params.userId,
        meetingId: params.meetingId,
      });
    },
  };

  // ── Calendar sync worker deps ──────────────────────────────────────

  const calendarSyncWorkerDeps = {
    firestoreAdapter: firestore,
    calendarService,
  };

  return {
    // Adapters (for plugins that need them directly)
    firestore,
    gcs,

    // Services
    meetingService,
    templateService,
    audioService,
    userNotesService,
    aiNotesService,
    actionService,
    searchService,
    aiQaService,
    calendarService,
    shareService,
    userService,

    // Processor / worker deps
    audioProcessorDeps,
    calendarSyncWorkerDeps,
  };
}
