/**
 * Adapters barrel file (ADR-005).
 *
 * Re-exports all adapter factory functions for clean imports
 * from the composition root.
 */

export { createClaudeAdapter } from './claude.js';
export type { ClaudeAdapter } from './claude.js';

export { createEmbeddingAdapter, chunkText } from './embedding.js';
export type { EmbeddingAdapter } from './embedding.js';

export { createFirestoreAdapter } from './firestore.js';

export { createGCSAdapter } from './gcs.js';

export { createGoogleCalendarAdapter } from './google-calendar.js';

export { createPubSubAdapter } from './pubsub.js';

export {
  createTranscriptionAdapter,
  DeepgramTranscriptionAdapter,
  WhisperTranscriptionAdapter,
  GoogleSttTranscriptionAdapter,
} from './transcription/index.js';
