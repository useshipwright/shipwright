/**
 * Calendar sync worker — triggered by Cloud Scheduler every 5 minutes.
 *
 * ADR-003: Cloud Scheduler for calendar sync cron instead of in-process timer.
 * Iterates all users with calendarConnected=true, performs incremental sync
 * per user via CalendarService, and logs results. Errors for individual users
 * are caught and logged so one user's failure doesn't block others.
 *
 * SECURITY:
 * - Endpoint authenticated via OIDC token (not Firebase JWT)
 * - Only iterates users with valid calendar connections
 * - All Firestore queries scoped by userId (IDOR prevention)
 */

import type { FirestoreAdapter } from '../types/adapters.js';
import type { CalendarService, SyncResult } from './calendar.js';
import { logger } from '../logger.js';

// ── Types ────────────────────────────────────────────────────────────

export interface CalendarSyncWorkerDeps {
  firestoreAdapter: FirestoreAdapter;
  calendarService: CalendarService;
}

export interface CalendarSyncWorkerResult {
  usersProcessed: number;
  usersSucceeded: number;
  usersFailed: number;
  totalNewMeetings: number;
  totalEventsProcessed: number;
}

// ── Worker ───────────────────────────────────────────────────────────

export async function runCalendarSync(
  deps: CalendarSyncWorkerDeps,
): Promise<CalendarSyncWorkerResult> {
  const { firestoreAdapter, calendarService } = deps;
  const log = logger.child({ worker: 'calendar-sync' });

  const users = await firestoreAdapter.listConnectedCalendarUsers();
  log.info({ userCount: users.length }, 'Starting calendar sync');

  let usersSucceeded = 0;
  let usersFailed = 0;
  let totalNewMeetings = 0;
  let totalEventsProcessed = 0;

  for (const user of users) {
    try {
      const result: SyncResult = await calendarService.sync(user.id);
      usersSucceeded++;
      totalNewMeetings += result.newMeetings;
      totalEventsProcessed += result.eventsProcessed;

      if (result.newMeetings > 0 || result.updatedMeetings > 0) {
        log.info(
          {
            userId: user.id,
            newMeetings: result.newMeetings,
            updatedMeetings: result.updatedMeetings,
            eventsProcessed: result.eventsProcessed,
          },
          'User calendar sync completed with changes',
        );
      }
    } catch (err) {
      usersFailed++;
      log.error(
        { err, userId: user.id },
        'Calendar sync failed for user — continuing with next user',
      );
    }
  }

  const result: CalendarSyncWorkerResult = {
    usersProcessed: users.length,
    usersSucceeded,
    usersFailed,
    totalNewMeetings,
    totalEventsProcessed,
  };

  log.info(result, 'Calendar sync batch completed');
  return result;
}
