/**
 * User service tests — T-031.
 *
 * Tests profile management and GDPR-compliant account deletion cascade.
 * Verifies deletion cascades to all user data: meetings, audio in GCS,
 * notes, actions, shares, templates, calendar tokens, embeddings, profile.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createUserService, type UserService } from '../../src/services/user.js';
import type { FirestoreAdapter, GCSAdapter } from '../../src/types/adapters.js';
import type { User } from '../../src/types/domain.js';

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
    listMeetings: vi.fn(),
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

function mockGCS(): GCSAdapter {
  return {
    upload: vi.fn(),
    createWriteStream: vi.fn(),
    getSignedUrl: vi.fn(),
    delete: vi.fn(),
    deleteByPrefix: vi.fn(),
    healthCheck: vi.fn(),
  } as unknown as GCSAdapter;
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'user@test.com',
    displayName: 'Test User',
    transcriptionBackend: 'deepgram',
    autoTranscribe: true,
    timezone: 'UTC',
    language: 'en',
    calendarConnected: false,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('User Service', () => {
  let firestore: FirestoreAdapter;
  let gcs: GCSAdapter;
  let service: UserService;

  beforeEach(() => {
    vi.clearAllMocks();
    firestore = mockFirestore();
    gcs = mockGCS();
    service = createUserService({ firestore, gcs });
  });

  describe('getProfile', () => {
    it('returns existing user profile', async () => {
      const user = makeUser();
      vi.mocked(firestore.getUser).mockResolvedValue(user);

      const result = await service.getProfile('user-1', 'user@test.com');

      expect(result).toEqual(user);
      expect(firestore.createUser).not.toHaveBeenCalled();
    });

    it('auto-creates profile on first access', async () => {
      vi.mocked(firestore.getUser).mockResolvedValue(null);

      const result = await service.getProfile('user-1', 'user@test.com');

      expect(result.id).toBe('user-1');
      expect(result.email).toBe('user@test.com');
      expect(result.transcriptionBackend).toBe('deepgram');
      expect(result.autoTranscribe).toBe(true);
      expect(result.timezone).toBe('UTC');
      expect(result.language).toBe('en');
      expect(firestore.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1', email: 'user@test.com' }),
      );
    });
  });

  describe('updateProfile', () => {
    it('updates user preferences (default template)', async () => {
      vi.mocked(firestore.getUser).mockResolvedValue(makeUser());

      const result = await service.updateProfile('user-1', {
        defaultTemplateId: 'tpl-custom',
      });

      expect(result.defaultTemplateId).toBe('tpl-custom');
      expect(firestore.updateUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ defaultTemplateId: 'tpl-custom' }),
      );
    });

    it('updates transcription backend', async () => {
      vi.mocked(firestore.getUser).mockResolvedValue(makeUser());

      const result = await service.updateProfile('user-1', {
        transcriptionBackend: 'whisper',
      });

      expect(result.transcriptionBackend).toBe('whisper');
    });

    it('updates auto-transcribe setting', async () => {
      vi.mocked(firestore.getUser).mockResolvedValue(makeUser());

      const result = await service.updateProfile('user-1', {
        autoTranscribe: false,
      });

      expect(result.autoTranscribe).toBe(false);
    });

    it('updates timezone', async () => {
      vi.mocked(firestore.getUser).mockResolvedValue(makeUser());

      const result = await service.updateProfile('user-1', {
        timezone: 'America/New_York',
      });

      expect(result.timezone).toBe('America/New_York');
    });

    it('updates language', async () => {
      vi.mocked(firestore.getUser).mockResolvedValue(makeUser());

      const result = await service.updateProfile('user-1', {
        language: 'fr',
      });

      expect(result.language).toBe('fr');
    });

    it('throws when user not found', async () => {
      vi.mocked(firestore.getUser).mockResolvedValue(null);

      await expect(
        service.updateProfile('nonexistent', { timezone: 'UTC' }),
      ).rejects.toThrow('User not found');
    });

    it('sets updatedAt timestamp', async () => {
      vi.mocked(firestore.getUser).mockResolvedValue(makeUser());

      await service.updateProfile('user-1', { language: 'de' });

      expect(firestore.updateUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          updatedAt: expect.any(Date),
        }),
      );
    });
  });

  describe('deleteAccount', () => {
    it('cascades deletion to GCS audio files', async () => {
      await service.deleteAccount('user-1');

      expect(gcs.deleteByPrefix).toHaveBeenCalledWith('audio/user-1/');
    });

    it('cascades deletion to all Firestore data', async () => {
      await service.deleteAccount('user-1');

      expect(firestore.deleteAllUserData).toHaveBeenCalledWith('user-1');
    });

    it('deletes GCS before Firestore (saga order)', async () => {
      const callOrder: string[] = [];
      vi.mocked(gcs.deleteByPrefix).mockImplementation(async () => {
        callOrder.push('gcs');
      });
      vi.mocked(firestore.deleteAllUserData).mockImplementation(async () => {
        callOrder.push('firestore');
      });

      await service.deleteAccount('user-1');

      expect(callOrder).toEqual(['gcs', 'firestore']);
    });

    it('continues Firestore deletion even when GCS fails (best-effort)', async () => {
      vi.mocked(gcs.deleteByPrefix).mockRejectedValue(new Error('GCS down'));

      await service.deleteAccount('user-1');

      // Firestore deletion still called despite GCS failure
      expect(firestore.deleteAllUserData).toHaveBeenCalledWith('user-1');
    });

    it('throws when Firestore deletion fails', async () => {
      vi.mocked(firestore.deleteAllUserData).mockRejectedValue(new Error('DB error'));

      await expect(service.deleteAccount('user-1')).rejects.toThrow('Account deletion failed');
    });

    it('uses correct GCS prefix for user audio (audio/{userId}/)', async () => {
      await service.deleteAccount('user-42');

      expect(gcs.deleteByPrefix).toHaveBeenCalledWith('audio/user-42/');
    });
  });
});
