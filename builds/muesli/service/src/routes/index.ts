import { type FastifyInstance } from 'fastify';
import { type AppDependencies } from '../app.js';

import meetingRoutes from './meetings.js';
import templateRoutes from './templates.js';
import audioRoutes from './audio.js';
import streamRoutes from './stream.js';
import userNotesRoutes from './user-notes.js';
import notesGenerateRoutes from './notes-generate.js';
import actionRoutes from './actions.js';
import { meetingActionsRoutes } from './actions.js';
import searchRoutes from './search.js';
import aiRoutes from './ai.js';
import calendarRoutes from './calendar.js';
import shareRoutes from './share.js';
import { meetingShareRoutes } from './share.js';
import userRoutes from './user.js';
import internalRoutes from './internal.js';

/**
 * Register all application routes.
 * Template contract: single entry point for route wiring.
 *
 * Routes not registered here are dead code — they will 404.
 */
export async function registerRoutes(
  app: FastifyInstance,
  deps: Partial<AppDependencies> = {},
): Promise<void> {
  // ── Meeting CRUD (/api/meetings) ────────────────────────────────────
  await app.register(meetingRoutes, {
    prefix: '/api/meetings',
    meetingService: deps.meetingService!,
  });

  // ── Audio upload & playback (/api/meetings/:id/audio) ──────────────
  await app.register(audioRoutes, {
    prefix: '/api/meetings',
    audioService: deps.audioService!,
  });

  // ── WebSocket streaming (/api/meetings/:id/stream) ─────────────────
  await app.register(streamRoutes, {
    prefix: '/api/meetings',
    audioService: deps.audioService!,
  });

  // ── User notes (/api/meetings/:id/user-notes) ─────────────────────
  await app.register(userNotesRoutes, {
    prefix: '/api/meetings',
    userNotesService: deps.userNotesService!,
  });

  // ── AI note generation (/api/meetings/:id/notes/generate) ──────────
  await app.register(notesGenerateRoutes, {
    prefix: '/api/meetings',
    aiNotesService: deps.aiNotesService!,
  });

  // ── Meeting-scoped actions (/api/meetings/:id/actions) ─────────────
  await app.register(meetingActionsRoutes, {
    prefix: '/api/meetings',
    actionService: deps.actionService!,
  });

  // ── Meeting-scoped shares (/api/meetings/:id/share(s)) ─────────────
  await app.register(meetingShareRoutes, {
    prefix: '/api/meetings',
    shareService: deps.shareService!,
  });

  // ── Templates (/api/templates) ─────────────────────────────────────
  await app.register(templateRoutes, {
    prefix: '/api/templates',
    templateService: deps.templateService!,
  });

  // ── Actions (/api/actions) ─────────────────────────────────────────
  await app.register(actionRoutes, {
    prefix: '/api/actions',
    actionService: deps.actionService!,
  });

  // ── Search (/api/search) ───────────────────────────────────────────
  await app.register(searchRoutes, {
    prefix: '/api/search',
    searchService: deps.searchService!,
  });

  // ── AI Q&A (/api/ai) ──────────────────────────────────────────────
  await app.register(aiRoutes, {
    prefix: '/api/ai',
    aiQaService: deps.aiQaService!,
  });

  // ── Calendar (/api/calendar) ───────────────────────────────────────
  await app.register(calendarRoutes, {
    prefix: '/api/calendar',
    calendarService: deps.calendarService!,
  });

  // ── Share public endpoint (/api/share) ─────────────────────────────
  await app.register(shareRoutes, {
    prefix: '/api/share',
    shareService: deps.shareService!,
  });

  // ── User profile (/api/me) ────────────────────────────────────────
  await app.register(userRoutes, {
    prefix: '/api/me',
    userService: deps.userService!,
  });

  // ── Internal routes (/internal) ────────────────────────────────────
  await app.register(internalRoutes, {
    prefix: '/internal',
    audioProcessorDeps: deps.audioProcessorDeps!,
    calendarSyncWorkerDeps: deps.calendarSyncWorkerDeps,
  });
}
