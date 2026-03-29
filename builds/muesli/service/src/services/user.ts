/**
 * User service layer — business logic for profile management and GDPR account deletion.
 *
 * SECURITY:
 * - All operations scoped by userId from verified JWT (IDOR prevention)
 * - Account deletion cascades to all user data per threat model
 * - Each deletion step is logged for audit trail
 * - Calendar tokens are cleaned up on deletion
 * - No internal details leaked in errors
 */

import type { FirestoreAdapter, GCSAdapter } from '../types/adapters.js';
import type { User, TranscriptionBackend } from '../types/domain.js';
import { logger } from '../logger.js';

// ── Service interface ───────────────────────────────────────────────

export interface UserServiceDeps {
  firestore: FirestoreAdapter;
  gcs: GCSAdapter;
}

export interface UpdateProfileParams {
  displayName?: string;
  defaultTemplateId?: string;
  transcriptionBackend?: TranscriptionBackend;
  autoTranscribe?: boolean;
  timezone?: string;
  language?: string;
}

export type UserService = ReturnType<typeof createUserService>;

// ── Service factory ─────────────────────────────────────────────────

export function createUserService(deps: UserServiceDeps) {
  const { firestore, gcs } = deps;

  return {
    /**
     * Get user profile. Creates a default profile if none exists.
     */
    async getProfile(userId: string, email: string): Promise<User> {
      const existing = await firestore.getUser(userId);
      if (existing) return existing;

      // Auto-create user profile on first access
      const now = new Date();
      const newUser: User = {
        id: userId,
        email,
        transcriptionBackend: 'deepgram',
        autoTranscribe: true,
        timezone: 'UTC',
        language: 'en',
        calendarConnected: false,
        createdAt: now,
        updatedAt: now,
      };
      await firestore.createUser(newUser);
      return newUser;
    },

    /**
     * Update user preferences. Only the provided fields are updated.
     */
    async updateProfile(userId: string, params: UpdateProfileParams): Promise<User> {
      // Ensure user exists
      const existing = await firestore.getUser(userId);
      if (!existing) {
        throw new Error('User not found');
      }

      const updateData: Partial<User> = {
        ...params,
        updatedAt: new Date(),
      };

      await firestore.updateUser(userId, updateData);

      return { ...existing, ...updateData } as User;
    },

    /**
     * GDPR-compliant account deletion.
     * Cascades deletion to all user data in a saga pattern:
     * 1. Audio files in GCS (audio/{userId}/ prefix)
     * 2. All Firestore data (meetings, notes, actions, shares, templates, embeddings, profile)
     *
     * Each step is logged for audit trail. Failures are logged but do not
     * prevent subsequent steps from executing (best-effort cascade).
     */
    async deleteAccount(userId: string): Promise<void> {
      logger.info({ userId }, 'Account deletion started');

      // Step 1: Delete all audio files in GCS
      try {
        const audioPrefix = `audio/${userId}/`;
        await gcs.deleteByPrefix(audioPrefix);
        logger.info({ userId, step: 'gcs_audio' }, 'Audio files deleted from GCS');
      } catch (err) {
        logger.error({ userId, step: 'gcs_audio', err }, 'Failed to delete audio files from GCS');
      }

      // Step 2: Delete all Firestore data (meetings + subcollections, actions, shares, templates, embeddings, profile)
      try {
        await firestore.deleteAllUserData(userId);
        logger.info({ userId, step: 'firestore_data' }, 'All Firestore data deleted');
      } catch (err) {
        logger.error({ userId, step: 'firestore_data', err }, 'Failed to delete Firestore data');
        throw new Error('Account deletion failed', { cause: err });
      }

      logger.info({ userId }, 'Account deletion completed');
    },
  };
}
