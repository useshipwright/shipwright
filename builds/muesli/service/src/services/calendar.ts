/**
 * Calendar service — business logic for Google Calendar OAuth2 integration,
 * event listing, incremental sync, and auto-creation of meeting records.
 *
 * SECURITY:
 * - OAuth2 state parameter is HMAC-signed with timestamp, bound to userId
 * - State rejected if older than 10 minutes (threat model: Calendar OAuth2 CSRF)
 * - Refresh tokens stored encrypted in Firestore via TokenEncryptor (T-039)
 * - redirect_uri is strictly validated against configured callback URL
 * - All Firestore queries include userId scope (IDOR prevention)
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { FirestoreAdapter } from '../types/adapters.js';
import type { GoogleCalendarAdapter, CalendarEvent } from '../types/adapters.js';
import type { Meeting } from '../types/domain.js';
import type { TokenEncryptor } from '../utils/crypto.js';
import { logger } from '../logger.js';

// ── Constants ────────────────────────────────────────────────────────

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

// ── Types ────────────────────────────────────────────────────────────

export interface CalendarServiceDeps {
  firestoreAdapter: FirestoreAdapter;
  calendarAdapter: GoogleCalendarAdapter;
  tokenEncryptor: TokenEncryptor;
  hmacSecret: string;
}

export interface ConnectResult {
  authUrl: string;
}

export interface CallbackResult {
  connected: boolean;
}

export interface SyncResult {
  newMeetings: number;
  updatedMeetings: number;
  eventsProcessed: number;
}

export interface CalendarService {
  generateConnectUrl(userId: string): ConnectResult;
  handleCallback(userId: string, code: string, state: string): Promise<CallbackResult>;
  listEvents(userId: string, timeMin: Date, timeMax: Date): Promise<CalendarEvent[]>;
  sync(userId: string): Promise<SyncResult>;
  disconnect(userId: string): Promise<void>;
}

// ── State Parameter Helpers ──────────────────────────────────────────

function createState(userId: string, hmacSecret: string): string {
  const payload = JSON.stringify({ userId, ts: Date.now() });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const signature = createHmac('sha256', hmacSecret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

function verifyState(
  state: string,
  expectedUserId: string,
  hmacSecret: string,
): { valid: boolean; error?: string } {
  const parts = state.split('.');
  if (parts.length !== 2) {
    return { valid: false, error: 'Malformed state parameter' };
  }

  const [payloadB64, signature] = parts;
  const expectedSig = createHmac('sha256', hmacSecret).update(payloadB64).digest('base64url');

  // Constant-time comparison
  const sigBuf = new Uint8Array(Buffer.from(signature, 'base64url'));
  const expectedBuf = new Uint8Array(Buffer.from(expectedSig, 'base64url'));
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, error: 'Invalid state signature' };
  }

  let parsed: { userId: string; ts: number };
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  } catch {
    return { valid: false, error: 'Malformed state payload' };
  }

  if (parsed.userId !== expectedUserId) {
    return { valid: false, error: 'State userId mismatch' };
  }

  const age = Date.now() - parsed.ts;
  if (age > STATE_MAX_AGE_MS) {
    return { valid: false, error: 'State parameter expired' };
  }

  if (age < 0) {
    return { valid: false, error: 'State timestamp in the future' };
  }

  return { valid: true };
}

// ── Service Factory ──────────────────────────────────────────────────

export function createCalendarService(deps: CalendarServiceDeps): CalendarService {
  const { firestoreAdapter, calendarAdapter, tokenEncryptor, hmacSecret } = deps;

  async function getUserTokens(
    userId: string,
  ): Promise<{ accessToken: string; refreshToken: string } | null> {
    const user = await firestoreAdapter.getUser(userId);
    if (!user?.calendarConnected || !user.calendarTokens) return null;

    const decryptedAccess = await tokenEncryptor.decrypt(user.calendarTokens.accessToken);
    const decryptedRefresh = await tokenEncryptor.decrypt(user.calendarTokens.refreshToken);
    return { accessToken: decryptedAccess, refreshToken: decryptedRefresh };
  }

  return {
    generateConnectUrl(userId: string): ConnectResult {
      const state = createState(userId, hmacSecret);
      const authUrl = calendarAdapter.getAuthUrl(userId, state);
      return { authUrl };
    },

    async handleCallback(userId: string, code: string, state: string): Promise<CallbackResult> {
      // Validate state parameter
      const stateResult = verifyState(state, userId, hmacSecret);
      if (!stateResult.valid) {
        logger.warn({ userId, error: stateResult.error }, 'Calendar OAuth state validation failed');
        const err = new Error(stateResult.error ?? 'Invalid state parameter');
        (err as Error & { statusCode: number }).statusCode = 400;
        throw err;
      }

      // Exchange authorization code for tokens
      const tokens = await calendarAdapter.exchangeCode(code);

      // Encrypt tokens before storing
      const encryptedAccess = await tokenEncryptor.encrypt(tokens.accessToken);
      const encryptedRefresh = await tokenEncryptor.encrypt(tokens.refreshToken);

      // Update user document with encrypted calendar tokens
      await firestoreAdapter.updateUser(userId, {
        calendarConnected: true,
        calendarTokens: {
          accessToken: encryptedAccess,
          refreshToken: encryptedRefresh,
          expiry: tokens.expiry,
        },
        updatedAt: new Date(),
      });

      logger.info({ userId }, 'Google Calendar connected');
      return { connected: true };
    },

    async listEvents(userId: string, timeMin: Date, timeMax: Date): Promise<CalendarEvent[]> {
      const tokens = await getUserTokens(userId);
      if (!tokens) {
        const err = new Error('Calendar not connected');
        (err as Error & { statusCode: number }).statusCode = 400;
        throw err;
      }

      return calendarAdapter.listEvents(tokens.accessToken, tokens.refreshToken, timeMin, timeMax);
    },

    async sync(userId: string): Promise<SyncResult> {
      const user = await firestoreAdapter.getUser(userId);
      if (!user?.calendarConnected || !user.calendarTokens) {
        const err = new Error('Calendar not connected');
        (err as Error & { statusCode: number }).statusCode = 400;
        throw err;
      }

      const tokens = await getUserTokens(userId);
      if (!tokens) {
        const err = new Error('Calendar not connected');
        (err as Error & { statusCode: number }).statusCode = 400;
        throw err;
      }

      let events: CalendarEvent[];
      let newSyncToken: string | undefined;

      if (user.calendarSyncToken) {
        // Incremental sync
        const result = await calendarAdapter.incrementalSync(
          tokens.accessToken,
          tokens.refreshToken,
          user.calendarSyncToken,
        );
        events = result.events;
        newSyncToken = result.nextSyncToken;
      } else {
        // Initial sync — fetch events from now to 7 days ahead
        const now = new Date();
        const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        events = await calendarAdapter.listEvents(
          tokens.accessToken,
          tokens.refreshToken,
          now,
          sevenDaysLater,
        );
      }

      let newMeetings = 0;
      let updatedMeetings = 0;

      for (const event of events) {
        // Check if a meeting already exists for this calendar event
        const existingMeetings = await firestoreAdapter.listMeetings({
          userId,
          limit: 1,
        });

        const existing = existingMeetings.meetings.find(
          (m) => m.calendarEventId === event.eventId,
        );

        if (!existing) {
          // Auto-create a meeting from the calendar event
          const meeting: Meeting = {
            id: crypto.randomUUID(),
            userId,
            title: event.summary,
            status: 'recording',
            startedAt: event.start,
            endedAt: event.end,
            durationSeconds: Math.round(
              (event.end.getTime() - event.start.getTime()) / 1000,
            ),
            attendees: event.attendees.map((a) => ({
              name: a.name ?? a.email,
              email: a.email,
            })),
            tags: [],
            isStarred: false,
            calendarEventId: event.eventId,
            latestNoteVersion: 0,
            searchTokens: event.summary
              .toLowerCase()
              .split(/\s+/)
              .filter(Boolean),
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          await firestoreAdapter.createMeeting(meeting);
          newMeetings++;
        } else {
          updatedMeetings++;
        }
      }

      // Persist the sync token for next incremental sync
      if (newSyncToken) {
        await firestoreAdapter.updateUser(userId, {
          calendarSyncToken: newSyncToken,
          updatedAt: new Date(),
        });
      }

      logger.info(
        { userId, newMeetings, updatedMeetings, eventsProcessed: events.length },
        'Calendar sync completed',
      );

      return { newMeetings, updatedMeetings, eventsProcessed: events.length };
    },

    async disconnect(userId: string): Promise<void> {
      const tokens = await getUserTokens(userId);

      // Revoke access at Google (best-effort)
      if (tokens) {
        await calendarAdapter.revokeAccess(tokens.accessToken);
      }

      // Clear calendar data from user document
      await firestoreAdapter.updateUser(userId, {
        calendarConnected: false,
        calendarTokens: undefined,
        calendarSyncToken: undefined,
        updatedAt: new Date(),
      });

      logger.info({ userId }, 'Google Calendar disconnected');
    },
  };
}
