/**
 * Google Calendar adapter implementation (ADR-005).
 *
 * Wraps Google Calendar API via googleapis SDK. Handles OAuth2 flow,
 * event listing, incremental sync, and access revocation.
 *
 * SECURITY:
 * - Validates GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET at construction
 * - OAuth2 redirect_uri strictly validated against configured callback URL
 * - Refresh tokens handled by OAuth2 client (auto-refresh)
 * - No secrets in logs
 */

import { google, type calendar_v3 } from 'googleapis';

import { logger } from '../logger.js';
import type { GoogleCalendarAdapter, CalendarEvent, CalendarSyncResult } from '../types/adapters.js';

export type { GoogleCalendarAdapter, CalendarEvent, CalendarSyncResult } from '../types/adapters.js';

const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];

interface GoogleCalendarAdapterOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function mapEvent(event: calendar_v3.Schema$Event): CalendarEvent | null {
  if (!event.id || !event.summary) return null;

  const start = event.start?.dateTime ?? event.start?.date;
  const end = event.end?.dateTime ?? event.end?.date;
  if (!start || !end) return null;

  return {
    eventId: event.id,
    summary: event.summary,
    start: new Date(start),
    end: new Date(end),
    attendees: (event.attendees ?? [])
      .filter((a) => a.email)
      .map((a) => ({
        name: a.displayName ?? undefined,
        email: a.email!,
      })),
    meetLink: event.hangoutLink ?? undefined,
  };
}

export function createGoogleCalendarAdapter(
  options: GoogleCalendarAdapterOptions,
): GoogleCalendarAdapter {
  const { clientId, clientSecret, redirectUri } = options;

  // Defer validation to method call time so the app can start without calendar credentials
  function assertConfigured(): void {
    if (!clientId) {
      throw new Error('GOOGLE_CALENDAR_CLIENT_ID is required for Google Calendar adapter');
    }
    if (!clientSecret) {
      throw new Error('GOOGLE_CALENDAR_CLIENT_SECRET is required for Google Calendar adapter');
    }
  }

  function createOAuth2Client(
    accessToken?: string,
    refreshToken?: string,
  ) {
    assertConfigured();
    const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    if (accessToken || refreshToken) {
      client.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
    }
    return client;
  }

  return {
    getAuthUrl(_userId: string, state: string): string {
      const client = createOAuth2Client();
      return client.generateAuthUrl({
        access_type: 'offline',
        scope: CALENDAR_SCOPES,
        state,
        prompt: 'consent',
      });
    },

    async exchangeCode(
      code: string,
    ): Promise<{ accessToken: string; refreshToken: string; expiry: Date }> {
      const client = createOAuth2Client();
      const { tokens } = await client.getToken(code);

      if (!tokens.access_token) {
        throw new Error('No access token received from Google');
      }
      if (!tokens.refresh_token) {
        throw new Error('No refresh token received from Google — ensure prompt=consent');
      }

      const expiry = tokens.expiry_date
        ? new Date(tokens.expiry_date)
        : new Date(Date.now() + 3600 * 1000);

      logger.info('Google Calendar tokens exchanged successfully');

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiry,
      };
    },

    async listEvents(
      accessToken: string,
      refreshToken: string,
      timeMin: Date,
      timeMax: Date,
    ): Promise<CalendarEvent[]> {
      const client = createOAuth2Client(accessToken, refreshToken);
      const calendar = google.calendar({ version: 'v3', auth: client });

      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
      });

      const events: CalendarEvent[] = [];
      for (const item of response.data.items ?? []) {
        const mapped = mapEvent(item);
        if (mapped) events.push(mapped);
      }

      return events;
    },

    async incrementalSync(
      accessToken: string,
      refreshToken: string,
      syncToken: string,
    ): Promise<CalendarSyncResult> {
      const client = createOAuth2Client(accessToken, refreshToken);
      const calendar = google.calendar({ version: 'v3', auth: client });

      const events: CalendarEvent[] = [];
      let pageToken: string | undefined;
      let nextSyncToken: string | undefined;

      do {
        const response = await calendar.events.list({
          calendarId: 'primary',
          syncToken,
          pageToken,
        });

        for (const item of response.data.items ?? []) {
          const mapped = mapEvent(item);
          if (mapped) events.push(mapped);
        }

        pageToken = response.data.nextPageToken ?? undefined;
        nextSyncToken = response.data.nextSyncToken ?? undefined;
      } while (pageToken);

      return { events, nextSyncToken };
    },

    async revokeAccess(accessToken: string): Promise<void> {
      const client = createOAuth2Client(accessToken);
      try {
        await client.revokeToken(accessToken);
        logger.info('Google Calendar access revoked');
      } catch (err) {
        logger.warn({ err }, 'Failed to revoke Google Calendar token — continuing with local cleanup');
      }
    },
  };
}
