/**
 * Google Calendar adapter tests — T-031.
 *
 * Tests the adapter layer that wraps the googleapis SDK.
 * Mocks googleapis via vi.mock (wrapping our own adapter, not the SDK directly
 * at consumption sites).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock googleapis before importing the adapter
const mockGenerateAuthUrl = vi.fn();
const mockGetToken = vi.fn();
const mockRevokeToken = vi.fn();
const mockSetCredentials = vi.fn();
const mockEventsList = vi.fn();

vi.mock('googleapis', () => {
  // Must be a real constructor (called with `new`)
  function OAuth2() {
    return {
      generateAuthUrl: mockGenerateAuthUrl,
      getToken: mockGetToken,
      revokeToken: mockRevokeToken,
      setCredentials: mockSetCredentials,
    };
  }

  return {
    google: {
      auth: { OAuth2 },
      calendar: () => ({
        events: {
          list: mockEventsList,
        },
      }),
    },
  };
});

import { createGoogleCalendarAdapter } from '../../src/adapters/google-calendar.js';
import type { GoogleCalendarAdapter } from '../../src/types/adapters.js';

// ── Fixtures ────────────────────────────────────────────────────────

const ADAPTER_OPTS = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://app.test/api/calendar/callback',
};

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    summary: 'Team Standup',
    start: { dateTime: '2025-06-01T09:00:00Z' },
    end: { dateTime: '2025-06-01T09:30:00Z' },
    attendees: [
      { email: 'alice@test.com', displayName: 'Alice' },
      { email: 'bob@test.com' },
    ],
    hangoutLink: 'https://meet.google.com/abc',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Google Calendar Adapter', () => {
  let adapter: GoogleCalendarAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = createGoogleCalendarAdapter(ADAPTER_OPTS);
  });

  describe('construction', () => {
    it('does not throw on construction with missing clientId (deferred validation)', () => {
      expect(() =>
        createGoogleCalendarAdapter({ ...ADAPTER_OPTS, clientId: '' }),
      ).not.toThrow();
    });

    it('throws when calling a method without clientId', () => {
      const noIdAdapter = createGoogleCalendarAdapter({ ...ADAPTER_OPTS, clientId: '' });
      expect(() => noIdAdapter.getAuthUrl('user-1', 'state')).toThrow('GOOGLE_CALENDAR_CLIENT_ID');
    });

    it('throws when calling a method without clientSecret', () => {
      const noSecretAdapter = createGoogleCalendarAdapter({ ...ADAPTER_OPTS, clientSecret: '' });
      expect(() => noSecretAdapter.getAuthUrl('user-1', 'state')).toThrow('GOOGLE_CALENDAR_CLIENT_SECRET');
    });
  });

  describe('getAuthUrl', () => {
    it('generates auth URL with correct scopes (calendar.readonly, calendar.events.readonly)', () => {
      mockGenerateAuthUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?...');

      const url = adapter.getAuthUrl('user-1', 'state-abc');

      expect(mockGenerateAuthUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          access_type: 'offline',
          scope: [
            'https://www.googleapis.com/auth/calendar.readonly',
            'https://www.googleapis.com/auth/calendar.events.readonly',
          ],
          state: 'state-abc',
          prompt: 'consent',
        }),
      );
      expect(url).toBe('https://accounts.google.com/o/oauth2/v2/auth?...');
    });
  });

  describe('exchangeCode', () => {
    it('exchanges authorization code for tokens', async () => {
      const expiryDate = Date.now() + 3600_000;
      mockGetToken.mockResolvedValue({
        tokens: {
          access_token: 'at-123',
          refresh_token: 'rt-456',
          expiry_date: expiryDate,
        },
      });

      const result = await adapter.exchangeCode('auth-code-xyz');

      expect(mockGetToken).toHaveBeenCalledWith('auth-code-xyz');
      expect(result.accessToken).toBe('at-123');
      expect(result.refreshToken).toBe('rt-456');
      expect(result.expiry).toEqual(new Date(expiryDate));
    });

    it('throws when no access token received', async () => {
      mockGetToken.mockResolvedValue({ tokens: {} });
      await expect(adapter.exchangeCode('code')).rejects.toThrow('No access token');
    });

    it('throws when no refresh token received', async () => {
      mockGetToken.mockResolvedValue({
        tokens: { access_token: 'at-123' },
      });
      await expect(adapter.exchangeCode('code')).rejects.toThrow('No refresh token');
    });

    it('defaults expiry to 1 hour when no expiry_date', async () => {
      const before = Date.now();
      mockGetToken.mockResolvedValue({
        tokens: { access_token: 'at', refresh_token: 'rt' },
      });

      const result = await adapter.exchangeCode('code');

      expect(result.expiry.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000 - 1000);
    });
  });

  describe('listEvents', () => {
    it('lists events within a date range', async () => {
      mockEventsList.mockResolvedValue({
        data: { items: [makeEvent()] },
      });

      const timeMin = new Date('2025-06-01');
      const timeMax = new Date('2025-06-07');
      const events = await adapter.listEvents('at', 'rt', timeMin, timeMax);

      expect(mockEventsList).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: 'primary',
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
        }),
      );
      expect(events).toHaveLength(1);
      expect(events[0].eventId).toBe('evt-1');
      expect(events[0].summary).toBe('Team Standup');
      expect(events[0].attendees).toHaveLength(2);
      expect(events[0].attendees[0].name).toBe('Alice');
      expect(events[0].attendees[1].email).toBe('bob@test.com');
      expect(events[0].meetLink).toBe('https://meet.google.com/abc');
    });

    it('filters out events without id or summary', async () => {
      mockEventsList.mockResolvedValue({
        data: { items: [{ id: null, summary: 'X' }, { id: 'e1' }] },
      });

      const events = await adapter.listEvents('at', 'rt', new Date(), new Date());
      expect(events).toHaveLength(0);
    });

    it('handles empty items list', async () => {
      mockEventsList.mockResolvedValue({ data: { items: [] } });
      const events = await adapter.listEvents('at', 'rt', new Date(), new Date());
      expect(events).toHaveLength(0);
    });
  });

  describe('incrementalSync', () => {
    it('performs incremental sync via sync tokens', async () => {
      mockEventsList.mockResolvedValue({
        data: {
          items: [makeEvent()],
          nextSyncToken: 'new-sync-token-abc',
        },
      });

      const result = await adapter.incrementalSync('at', 'rt', 'old-sync-token');

      expect(mockEventsList).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: 'primary',
          syncToken: 'old-sync-token',
        }),
      );
      expect(result.events).toHaveLength(1);
      expect(result.nextSyncToken).toBe('new-sync-token-abc');
    });

    it('handles paginated sync results', async () => {
      mockEventsList
        .mockResolvedValueOnce({
          data: {
            items: [makeEvent({ id: 'evt-1' })],
            nextPageToken: 'page2',
          },
        })
        .mockResolvedValueOnce({
          data: {
            items: [makeEvent({ id: 'evt-2', summary: 'Meeting 2' })],
            nextSyncToken: 'final-token',
          },
        });

      const result = await adapter.incrementalSync('at', 'rt', 'sync-tok');

      expect(mockEventsList).toHaveBeenCalledTimes(2);
      expect(result.events).toHaveLength(2);
      expect(result.nextSyncToken).toBe('final-token');
    });
  });

  describe('revokeAccess', () => {
    it('revokes token at Google', async () => {
      mockRevokeToken.mockResolvedValue(undefined);
      await adapter.revokeAccess('at-123');
      expect(mockRevokeToken).toHaveBeenCalledWith('at-123');
    });

    it('swallows revocation errors gracefully', async () => {
      mockRevokeToken.mockRejectedValue(new Error('network error'));
      await expect(adapter.revokeAccess('at-123')).resolves.toBeUndefined();
    });
  });
});
