/**
 * Calendar service tests — T-031.
 *
 * Tests business logic for Google Calendar OAuth2 integration,
 * incremental sync, and auto-creation of meeting records.
 * Mocks adapter interfaces per ADR-005.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createCalendarService, type CalendarService } from '../../src/services/calendar.js';
import type { FirestoreAdapter, GoogleCalendarAdapter, CalendarEvent } from '../../src/types/adapters.js';
import type { User, Meeting } from '../../src/types/domain.js';
import type { TokenEncryptor } from '../../src/utils/crypto.js';

// ── Mock factories ──────────────────────────────────────────────────

function mockFirestore(): FirestoreAdapter {
  return {
    getUser: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    deleteUser: vi.fn(),
    getMeeting: vi.fn(),
    createMeeting: vi.fn(),
    updateMeeting: vi.fn(),
    deleteMeeting: vi.fn(),
    listMeetings: vi.fn().mockResolvedValue({ meetings: [] }),
    getSegments: vi.fn(),
    batchWriteSegments: vi.fn(),
    getSpeakers: vi.fn(),
    updateSpeaker: vi.fn(),
    getNotes: vi.fn(),
    getNote: vi.fn(),
    getLatestNote: vi.fn(),
    createNote: vi.fn(),
    updateNote: vi.fn(),
    getTemplate: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
    listTemplates: vi.fn(),
    getAction: vi.fn(),
    createAction: vi.fn(),
    updateAction: vi.fn(),
    deleteAction: vi.fn(),
    listActions: vi.fn(),
    getShare: vi.fn(),
    createShare: vi.fn(),
    deleteShare: vi.fn(),
    listSharesByMeeting: vi.fn(),
    incrementShareViewCount: vi.fn(),
    storeEmbeddings: vi.fn(),
    deleteEmbeddingsByMeeting: vi.fn(),
    vectorSearch: vi.fn(),
    searchMeetings: vi.fn(),
    searchActions: vi.fn(),
    listConnectedCalendarUsers: vi.fn(),
    healthCheck: vi.fn(),
    deleteAllUserData: vi.fn(),
  } as unknown as FirestoreAdapter;
}

function mockCalendarAdapter(): GoogleCalendarAdapter {
  return {
    getAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/oauth?state=abc'),
    exchangeCode: vi.fn().mockResolvedValue({
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      expiry: new Date('2025-06-01T10:00:00Z'),
    }),
    listEvents: vi.fn().mockResolvedValue([]),
    incrementalSync: vi.fn().mockResolvedValue({ events: [], nextSyncToken: 'sync-2' }),
    revokeAccess: vi.fn().mockResolvedValue(undefined),
  };
}

function mockTokenEncryptor(): TokenEncryptor {
  return {
    encrypt: vi.fn().mockImplementation(async (v: string) => `enc:${v}`),
    decrypt: vi.fn().mockImplementation(async (v: string) => v.replace('enc:', '')),
  } as unknown as TokenEncryptor;
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'user@test.com',
    transcriptionBackend: 'deepgram',
    autoTranscribe: true,
    timezone: 'UTC',
    language: 'en',
    calendarConnected: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeConnectedUser(overrides: Partial<User> = {}): User {
  return makeUser({
    calendarConnected: true,
    calendarTokens: {
      accessToken: 'enc:at-stored',
      refreshToken: 'enc:rt-stored',
      expiry: new Date('2025-06-01T10:00:00Z'),
    },
    ...overrides,
  });
}

function makeCalendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    eventId: 'evt-1',
    summary: 'Team Standup',
    start: new Date('2025-06-01T09:00:00Z'),
    end: new Date('2025-06-01T09:30:00Z'),
    attendees: [
      { name: 'Alice', email: 'alice@test.com' },
      { email: 'bob@test.com' },
    ],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Calendar Service', () => {
  let firestore: FirestoreAdapter;
  let calendarAdapter: GoogleCalendarAdapter;
  let tokenEncryptor: TokenEncryptor;
  let service: CalendarService;
  const hmacSecret = 'test-hmac-secret-32-bytes-long!!';

  beforeEach(() => {
    vi.clearAllMocks();
    firestore = mockFirestore();
    calendarAdapter = mockCalendarAdapter();
    tokenEncryptor = mockTokenEncryptor();
    service = createCalendarService({
      firestoreAdapter: firestore,
      calendarAdapter,
      tokenEncryptor,
      hmacSecret,
    });
  });

  describe('generateConnectUrl', () => {
    it('generates OAuth2 URL with cryptographic state parameter bound to userId', () => {
      const result = service.generateConnectUrl('user-1');

      expect(result.authUrl).toBeDefined();
      expect(calendarAdapter.getAuthUrl).toHaveBeenCalledWith(
        'user-1',
        expect.stringMatching(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/), // base64url.signature format
      );
    });

    it('generates different state for different users', () => {
      service.generateConnectUrl('user-1');
      service.generateConnectUrl('user-2');

      const calls = vi.mocked(calendarAdapter.getAuthUrl).mock.calls;
      const state1 = calls[0][1];
      const state2 = calls[1][1];
      expect(state1).not.toBe(state2);
    });
  });

  describe('handleCallback', () => {
    it('validates state parameter to prevent CSRF', async () => {
      // Generate a valid state for user-1
      service.generateConnectUrl('user-1');
      const validState = vi.mocked(calendarAdapter.getAuthUrl).mock.calls[0][1];

      const result = await service.handleCallback('user-1', 'auth-code', validState);

      expect(result.connected).toBe(true);
      expect(calendarAdapter.exchangeCode).toHaveBeenCalledWith('auth-code');
    });

    it('rejects state for a different user (CSRF prevention)', async () => {
      service.generateConnectUrl('user-1');
      const stateForUser1 = vi.mocked(calendarAdapter.getAuthUrl).mock.calls[0][1];

      await expect(
        service.handleCallback('user-2', 'code', stateForUser1),
      ).rejects.toThrow();
    });

    it('rejects malformed state parameter', async () => {
      await expect(
        service.handleCallback('user-1', 'code', 'not.valid.state'),
      ).rejects.toThrow();
    });

    it('rejects state without signature', async () => {
      await expect(
        service.handleCallback('user-1', 'code', 'just-payload-no-dot'),
      ).rejects.toThrow();
    });

    it('stores encrypted tokens in Firestore under user document', async () => {
      service.generateConnectUrl('user-1');
      const validState = vi.mocked(calendarAdapter.getAuthUrl).mock.calls[0][1];

      await service.handleCallback('user-1', 'auth-code', validState);

      expect(tokenEncryptor.encrypt).toHaveBeenCalledWith('at-new');
      expect(tokenEncryptor.encrypt).toHaveBeenCalledWith('rt-new');
      expect(firestore.updateUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          calendarConnected: true,
          calendarTokens: expect.objectContaining({
            accessToken: 'enc:at-new',
            refreshToken: 'enc:rt-new',
          }),
        }),
      );
    });
  });

  describe('listEvents', () => {
    it('lists events using decrypted tokens', async () => {
      vi.mocked(firestore.getUser).mockResolvedValue(makeConnectedUser());

      const timeMin = new Date('2025-06-01');
      const timeMax = new Date('2025-06-07');
      await service.listEvents('user-1', timeMin, timeMax);

      expect(tokenEncryptor.decrypt).toHaveBeenCalled();
      expect(calendarAdapter.listEvents).toHaveBeenCalledWith(
        'at-stored',
        'rt-stored',
        timeMin,
        timeMax,
      );
    });

    it('throws 400 when calendar not connected', async () => {
      vi.mocked(firestore.getUser).mockResolvedValue(makeUser());

      await expect(
        service.listEvents('user-1', new Date(), new Date()),
      ).rejects.toThrow('Calendar not connected');
    });
  });

  describe('sync', () => {
    it('performs incremental sync when sync token exists', async () => {
      const user = makeConnectedUser({ calendarSyncToken: 'sync-token-1' });
      vi.mocked(firestore.getUser).mockResolvedValue(user);

      const event = makeCalendarEvent();
      vi.mocked(calendarAdapter.incrementalSync).mockResolvedValue({
        events: [event],
        nextSyncToken: 'sync-token-2',
      });

      const result = await service.sync('user-1');

      expect(calendarAdapter.incrementalSync).toHaveBeenCalledWith(
        'at-stored',
        'rt-stored',
        'sync-token-1',
      );
      expect(result.eventsProcessed).toBe(1);
      expect(result.newMeetings).toBe(1);
    });

    it('creates meeting records for upcoming events', async () => {
      const user = makeConnectedUser({ calendarSyncToken: 'sync-1' });
      vi.mocked(firestore.getUser).mockResolvedValue(user);

      const event = makeCalendarEvent();
      vi.mocked(calendarAdapter.incrementalSync).mockResolvedValue({
        events: [event],
        nextSyncToken: 'sync-2',
      });

      await service.sync('user-1');

      expect(firestore.createMeeting).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          title: 'Team Standup',
          calendarEventId: 'evt-1',
          attendees: expect.arrayContaining([
            expect.objectContaining({ email: 'alice@test.com' }),
          ]),
        }),
      );
    });

    it('resolves attendee emails to known users for speaker identification', async () => {
      const user = makeConnectedUser({ calendarSyncToken: 'sync-1' });
      vi.mocked(firestore.getUser).mockResolvedValue(user);

      const event = makeCalendarEvent({
        attendees: [
          { name: 'Alice', email: 'alice@test.com' },
          { email: 'unknown@test.com' },
        ],
      });
      vi.mocked(calendarAdapter.incrementalSync).mockResolvedValue({
        events: [event],
        nextSyncToken: 'sync-2',
      });

      await service.sync('user-1');

      expect(firestore.createMeeting).toHaveBeenCalledWith(
        expect.objectContaining({
          attendees: [
            { name: 'Alice', email: 'alice@test.com' },
            { name: 'unknown@test.com', email: 'unknown@test.com' },
          ],
        }),
      );
    });

    it('persists sync token for next incremental sync', async () => {
      const user = makeConnectedUser({ calendarSyncToken: 'sync-1' });
      vi.mocked(firestore.getUser).mockResolvedValue(user);

      vi.mocked(calendarAdapter.incrementalSync).mockResolvedValue({
        events: [],
        nextSyncToken: 'sync-2',
      });

      await service.sync('user-1');

      expect(firestore.updateUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ calendarSyncToken: 'sync-2' }),
      );
    });

    it('skips creation when meeting already exists for calendar event', async () => {
      const user = makeConnectedUser({ calendarSyncToken: 'sync-1' });
      vi.mocked(firestore.getUser).mockResolvedValue(user);

      const event = makeCalendarEvent();
      vi.mocked(calendarAdapter.incrementalSync).mockResolvedValue({
        events: [event],
        nextSyncToken: 'sync-2',
      });

      // Meeting already exists for this event
      const existingMeeting = {
        id: 'm-1',
        userId: 'user-1',
        calendarEventId: 'evt-1',
        title: 'Team Standup',
      } as Meeting;
      vi.mocked(firestore.listMeetings).mockResolvedValue({
        meetings: [existingMeeting],
      });

      const result = await service.sync('user-1');

      expect(result.newMeetings).toBe(0);
      expect(result.updatedMeetings).toBe(1);
      expect(firestore.createMeeting).not.toHaveBeenCalled();
    });

    it('does full sync when no sync token exists', async () => {
      const user = makeConnectedUser(); // no calendarSyncToken
      vi.mocked(firestore.getUser).mockResolvedValue(user);

      await service.sync('user-1');

      expect(calendarAdapter.listEvents).toHaveBeenCalled();
      expect(calendarAdapter.incrementalSync).not.toHaveBeenCalled();
    });

    it('throws 400 when calendar not connected', async () => {
      vi.mocked(firestore.getUser).mockResolvedValue(makeUser());

      await expect(service.sync('user-1')).rejects.toThrow('Calendar not connected');
    });
  });

  describe('disconnect', () => {
    it('revokes access and removes stored tokens', async () => {
      vi.mocked(firestore.getUser).mockResolvedValue(makeConnectedUser());

      await service.disconnect('user-1');

      expect(calendarAdapter.revokeAccess).toHaveBeenCalledWith('at-stored');
      expect(firestore.updateUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          calendarConnected: false,
          calendarTokens: undefined,
          calendarSyncToken: undefined,
        }),
      );
    });

    it('clears tokens even when revocation is a no-op (adapter swallows errors)', async () => {
      vi.mocked(firestore.getUser).mockResolvedValue(makeConnectedUser());
      // The real adapter swallows revocation errors internally.
      // Here we verify that disconnect still clears tokens even if
      // revokeAccess resolves without actually revoking at Google.
      vi.mocked(calendarAdapter.revokeAccess).mockResolvedValue(undefined);

      await service.disconnect('user-1');

      expect(firestore.updateUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ calendarConnected: false }),
      );
    });

    it('handles disconnecting when no tokens stored', async () => {
      vi.mocked(firestore.getUser).mockResolvedValue(makeUser());

      await service.disconnect('user-1');

      expect(calendarAdapter.revokeAccess).not.toHaveBeenCalled();
      expect(firestore.updateUser).toHaveBeenCalled();
    });
  });
});
