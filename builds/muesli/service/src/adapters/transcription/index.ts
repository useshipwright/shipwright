/**
 * Transcription adapter barrel file (ADR-005).
 *
 * Exports a factory function that returns the correct adapter instance
 * given a backend name string. Backend is selected per-user preference
 * or per-request override.
 */

import type { TranscriptionAdapter } from '../../types/adapters.js';
import type { TranscriptionBackend } from '../../types/domain.js';
import { config } from '../../config.js';
import { DeepgramTranscriptionAdapter } from './deepgram.js';
import { WhisperTranscriptionAdapter } from './whisper.js';
import { GoogleSttTranscriptionAdapter } from './google-stt.js';

export { DeepgramTranscriptionAdapter } from './deepgram.js';
export { WhisperTranscriptionAdapter } from './whisper.js';
export { GoogleSttTranscriptionAdapter } from './google-stt.js';

/**
 * Create a transcription adapter for the given backend.
 *
 * @throws Error if required configuration is missing for the selected backend.
 */
export function createTranscriptionAdapter(backend: TranscriptionBackend): TranscriptionAdapter {
  switch (backend) {
    case 'deepgram': {
      const apiKey = config.deepgramApiKey;
      if (!apiKey) {
        throw new Error('DEEPGRAM_API_KEY is required for Deepgram transcription backend');
      }
      return new DeepgramTranscriptionAdapter(apiKey);
    }
    case 'whisper': {
      const whisperEndpoint = config.whisperEndpoint;
      const diarizationEndpoint = config.diarizationEndpoint;
      if (!whisperEndpoint || !diarizationEndpoint) {
        throw new Error(
          'WHISPER_ENDPOINT and DIARIZATION_ENDPOINT are required for Whisper transcription backend',
        );
      }
      return new WhisperTranscriptionAdapter(whisperEndpoint, diarizationEndpoint);
    }
    case 'google-stt': {
      return new GoogleSttTranscriptionAdapter(config.googleCloudProject);
    }
    default: {
      const _exhaustive: never = backend;
      throw new Error(`Unknown transcription backend: ${_exhaustive}`);
    }
  }
}
