/**
 * Embedding adapter implementation (ADR-005, ADR-009).
 *
 * Pluggable embedding generation. Default: Vertex AI text-embedding-005
 * via @google/genai SDK. Fallback: configurable EMBEDDING_ENDPOINT for self-hosted.
 *
 * Chunks text into ~500-token segments. Non-blocking: failures degrade
 * semantic search but don't block note saving.
 *
 * Returns 768-dimension vectors matching Firestore HNSW index configuration.
 *
 * EMBEDDING_ENDPOINT is validated at construction time (must be HTTPS or
 * whitelisted internal address). Redirects are not followed (SSRF mitigation).
 */

import { GoogleGenAI } from '@google/genai';

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { EmbeddingAdapter } from '../types/adapters.js';

export type { EmbeddingAdapter } from '../types/adapters.js';

const VERTEX_MODEL = 'text-embedding-005';
const VECTOR_DIMENSIONS = 768;
const APPROX_CHARS_PER_TOKEN = 4;
const TARGET_CHUNK_TOKENS = 500;
const TARGET_CHUNK_CHARS = TARGET_CHUNK_TOKENS * APPROX_CHARS_PER_TOKEN;

/**
 * Chunk text into approximately 500-token segments.
 * Splits on sentence boundaries where possible, falling back to word boundaries.
 */
export function chunkText(text: string): string[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const trimmed = text.trim();
  if (trimmed.length <= TARGET_CHUNK_CHARS) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > 0) {
    if (remaining.length <= TARGET_CHUNK_CHARS) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a sentence boundary within the target range
    let splitIndex = -1;
    const searchWindow = remaining.slice(0, TARGET_CHUNK_CHARS + 200);

    // Look for sentence endings near the target length
    for (let i = Math.min(TARGET_CHUNK_CHARS, searchWindow.length) - 1; i >= TARGET_CHUNK_CHARS * 0.5; i--) {
      if (searchWindow[i] === '.' || searchWindow[i] === '!' || searchWindow[i] === '?') {
        // Ensure it's actually end-of-sentence (followed by space or end)
        if (i + 1 >= searchWindow.length || searchWindow[i + 1] === ' ' || searchWindow[i + 1] === '\n') {
          splitIndex = i + 1;
          break;
        }
      }
    }

    // Fall back to word boundary
    if (splitIndex === -1) {
      for (let i = TARGET_CHUNK_CHARS - 1; i >= TARGET_CHUNK_CHARS * 0.5; i--) {
        if (remaining[i] === ' ' || remaining[i] === '\n') {
          splitIndex = i + 1;
          break;
        }
      }
    }

    // Last resort: hard split at target length
    if (splitIndex === -1) {
      splitIndex = TARGET_CHUNK_CHARS;
    }

    const chunk = remaining.slice(0, splitIndex).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitIndex).trim();
  }

  return chunks;
}

/**
 * Validate that an endpoint URL is safe (HTTPS or whitelisted internal).
 * Throws if the URL is not acceptable (SSRF mitigation per threat model).
 */
function validateEndpointUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid EMBEDDING_ENDPOINT URL: ${url}`);
  }

  const isHttps = parsed.protocol === 'https:';
  const isLocalhost =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1' ||
    parsed.hostname === '[::1]';
  const isInternalK8s = parsed.hostname.endsWith('.svc.cluster.local');
  const isInternal = parsed.hostname.endsWith('.internal');

  if (!isHttps && !isLocalhost && !isInternalK8s && !isInternal) {
    throw new Error(
      `EMBEDDING_ENDPOINT must use HTTPS or be a whitelisted internal address. Got: ${url}`,
    );
  }
}

/**
 * Call a custom embedding endpoint. Sends POST with JSON body containing texts.
 * Does not follow redirects (SSRF mitigation).
 */
async function callCustomEndpoint(endpoint: string, texts: string[]): Promise<number[][]> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }),
    redirect: 'error',
  });

  if (!response.ok) {
    throw new Error(`Embedding endpoint returned ${response.status}: ${response.statusText}`);
  }

  const body = (await response.json()) as { embeddings: number[][] };

  if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) {
    throw new Error(
      `Embedding endpoint returned invalid response: expected ${texts.length} embeddings, got ${Array.isArray(body.embeddings) ? body.embeddings.length : 'non-array'}`,
    );
  }

  return body.embeddings;
}

export function createEmbeddingAdapter(): EmbeddingAdapter {
  const embeddingEndpoint = config.embeddingEndpoint;

  // Validate endpoint at construction time
  if (embeddingEndpoint) {
    validateEndpointUrl(embeddingEndpoint);
    logger.info({ endpoint: embeddingEndpoint }, 'Embedding adapter using custom endpoint');
  } else {
    logger.info(
      { model: VERTEX_MODEL, project: config.googleCloudProject },
      'Embedding adapter using Vertex AI',
    );
  }

  // Initialize Vertex AI client lazily (only when needed and not using custom endpoint)
  let genaiClient: GoogleGenAI | undefined;

  function getGenAIClient(): GoogleGenAI {
    if (!genaiClient) {
      genaiClient = new GoogleGenAI({
        vertexai: true,
        project: config.googleCloudProject,
        location: 'us-central1',
      });
    }
    return genaiClient;
  }

  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }

      // Chunk all input texts
      const allChunks: string[] = [];
      const chunkMapping: { textIndex: number; chunkStart: number; chunkCount: number }[] = [];

      for (let i = 0; i < texts.length; i++) {
        const chunks = chunkText(texts[i]);
        chunkMapping.push({
          textIndex: i,
          chunkStart: allChunks.length,
          chunkCount: chunks.length,
        });
        allChunks.push(...chunks);
      }

      if (allChunks.length === 0) {
        return texts.map(() => new Array<number>(VECTOR_DIMENSIONS).fill(0));
      }

      let chunkEmbeddings: number[][];

      if (embeddingEndpoint) {
        chunkEmbeddings = await callCustomEndpoint(embeddingEndpoint, allChunks);
      } else {
        const client = getGenAIClient();
        const response = await client.models.embedContent({
          model: VERTEX_MODEL,
          contents: allChunks.map((text) => ({ role: 'user', parts: [{ text }] })),
          config: {
            outputDimensionality: VECTOR_DIMENSIONS,
          },
        });

        if (!response.embeddings || response.embeddings.length !== allChunks.length) {
          throw new Error(
            `Vertex AI returned ${response.embeddings?.length ?? 0} embeddings for ${allChunks.length} chunks`,
          );
        }

        chunkEmbeddings = response.embeddings.map((e) => e.values ?? []);
      }

      // Average chunk embeddings back to per-text embeddings
      const results: number[][] = [];
      for (const mapping of chunkMapping) {
        if (mapping.chunkCount === 0) {
          results.push(new Array<number>(VECTOR_DIMENSIONS).fill(0));
          continue;
        }

        if (mapping.chunkCount === 1) {
          results.push(chunkEmbeddings[mapping.chunkStart]);
          continue;
        }

        // Average the chunk embeddings for multi-chunk texts
        const dims = chunkEmbeddings[mapping.chunkStart].length;
        const averaged = new Array<number>(dims).fill(0);
        for (let c = 0; c < mapping.chunkCount; c++) {
          const vec = chunkEmbeddings[mapping.chunkStart + c];
          for (let d = 0; d < dims; d++) {
            averaged[d] += vec[d];
          }
        }
        // Normalize: average then L2-normalize
        let norm = 0;
        for (let d = 0; d < dims; d++) {
          averaged[d] /= mapping.chunkCount;
          norm += averaged[d] * averaged[d];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
          for (let d = 0; d < dims; d++) {
            averaged[d] /= norm;
          }
        }
        results.push(averaged);
      }

      logger.info(
        {
          inputTexts: texts.length,
          totalChunks: allChunks.length,
          backend: embeddingEndpoint ? 'custom' : 'vertex-ai',
        },
        'Embedding generation completed',
      );

      return results;
    },
  };
}
