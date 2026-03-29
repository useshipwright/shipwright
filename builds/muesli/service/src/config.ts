function parseIntOrDefault(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: "${value}" (must be a positive integer)`);
  }
  return parsed;
}

export const config = {
  // --- Base ---
  port: parseIntOrDefault(process.env.PORT, 8080, 'PORT'),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',

  // --- Security / Networking ---
  trustProxy: process.env.TRUST_PROXY !== 'false',
  corsOrigin: process.env.CORS_ORIGIN || '',

  // --- Rate Limiting ---
  rateLimitMax: parseIntOrDefault(process.env.RATE_LIMIT_MAX, 100, 'RATE_LIMIT_MAX'),
  rateLimitWindow: process.env.RATE_LIMIT_WINDOW || '1 minute',

  // --- Lifecycle ---
  shutdownTimeoutMs: parseIntOrDefault(
    process.env.SHUTDOWN_TIMEOUT_MS, 10_000, 'SHUTDOWN_TIMEOUT_MS',
  ),

  // --- Pack-specific ---

  // Firebase / GCP
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || '',
  googleCloudProject: process.env.GOOGLE_CLOUD_PROJECT || '',
  gcsBucket: process.env.GCS_BUCKET || '',

  // AI
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  maxTranscriptTokens: parseIntOrDefault(process.env.MAX_TRANSCRIPT_TOKENS, 100_000, 'MAX_TRANSCRIPT_TOKENS'),

  // Transcription
  deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
  whisperEndpoint: process.env.WHISPER_ENDPOINT || '',
  diarizationEndpoint: process.env.DIARIZATION_ENDPOINT || '',
  embeddingEndpoint: process.env.EMBEDDING_ENDPOINT || '',

  // Google Calendar
  googleCalendarClientId: process.env.GOOGLE_CALENDAR_CLIENT_ID || '',
  googleCalendarClientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET || '',
  googleCalendarRedirectUri: process.env.GOOGLE_CALENDAR_REDIRECT_URI || '',

  // Pub/Sub
  pubsubTopicAudio: process.env.PUBSUB_TOPIC_AUDIO || 'audio-processing',

  // Security
  tokenEncryptionSecretId: process.env.TOKEN_ENCRYPTION_SECRET_ID || '',
  calendarHmacSecret: process.env.CALENDAR_HMAC_SECRET || '',
} as const;
