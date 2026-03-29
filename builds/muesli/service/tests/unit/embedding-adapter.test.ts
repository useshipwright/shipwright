/**
 * Embedding adapter unit tests — T-030.
 *
 * Tests default Vertex AI text-embedding-005 backend, custom EMBEDDING_ENDPOINT
 * fallback, text chunking into ~500-token segments, and non-blocking behavior
 * where failures degrade search but don't block note saving.
 *
 * Strategy: Mock @google/genai SDK via vi.mock (adapter wraps the SDK).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @google/genai ──────────────────────────────────────────────

const mockEmbedContent = vi.fn();

vi.mock('@google/genai', () => {
  class MockGoogleGenAI {
    models = { embedContent: mockEmbedContent };
  }
  return { GoogleGenAI: MockGoogleGenAI };
});

let mockConfig: Record<string, string | number> = {};
vi.mock('../../src/config.js', () => ({
  config: new Proxy({} as Record<string, string | number>, {
    get(_target, prop: string) {
      return mockConfig[prop] ?? '';
    },
  }),
}));

vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { chunkText, createEmbeddingAdapter } from '../../src/adapters/embedding.js';
import type { EmbeddingAdapter } from '../../src/types/adapters.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeEmbeddings(count: number): { values: number[] }[] {
  return Array.from({ length: count }, () => ({
    values: new Array(768).fill(0.1),
  }));
}

// ── chunkText unit tests ─────────────────────────────────────────────

describe('chunkText', () => {
  it('should return empty array for empty string', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('should return single chunk for short text', () => {
    const text = 'Short meeting notes about quarterly planning.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('should split long text into approximately 500-token segments', () => {
    // ~500 tokens ≈ 2000 chars. Create text that's ~4000 chars
    const sentence = 'This is a test sentence about meeting notes and action items. ';
    const longText = sentence.repeat(70); // ~70 * 62 = ~4340 chars
    const chunks = chunkText(longText);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Each chunk should be roughly under 2200 chars (500 tokens * 4 chars + buffer)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2400);
    }
  });

  it('should split on sentence boundaries when possible', () => {
    const text =
      'First sentence about the project. '.repeat(30) +
      'Second topic sentence about budgets. '.repeat(30);
    const chunks = chunkText(text);

    // Chunks should end on sentence boundaries (period)
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].endsWith('.')).toBe(true);
    }
  });

  it('should handle whitespace-only text', () => {
    expect(chunkText('   ')).toEqual([]);
  });
});

// ── EmbeddingAdapter tests ───────────────────────────────────────────

describe('EmbeddingAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = {
      googleCloudProject: 'test-project',
      embeddingEndpoint: '',
    };
  });

  describe('Vertex AI (default backend)', () => {
    it('should use text-embedding-005 model', async () => {
      mockEmbedContent.mockResolvedValueOnce({
        embeddings: makeEmbeddings(1),
      });

      const adapter = createEmbeddingAdapter();
      await adapter.embed(['test text']);

      expect(mockEmbedContent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'text-embedding-005',
        }),
      );
    });

    it('should return 768-dimension vectors', async () => {
      mockEmbedContent.mockResolvedValueOnce({
        embeddings: makeEmbeddings(1),
      });

      const adapter = createEmbeddingAdapter();
      const result = await adapter.embed(['test text']);

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveLength(768);
    });

    it('should handle multiple texts', async () => {
      mockEmbedContent.mockResolvedValueOnce({
        embeddings: makeEmbeddings(3),
      });

      const adapter = createEmbeddingAdapter();
      const result = await adapter.embed(['text one', 'text two', 'text three']);

      expect(result).toHaveLength(3);
    });

    it('should return empty array for empty input', async () => {
      const adapter = createEmbeddingAdapter();
      const result = await adapter.embed([]);

      expect(result).toEqual([]);
      expect(mockEmbedContent).not.toHaveBeenCalled();
    });

    it('should request outputDimensionality of 768', async () => {
      mockEmbedContent.mockResolvedValueOnce({
        embeddings: makeEmbeddings(1),
      });

      const adapter = createEmbeddingAdapter();
      await adapter.embed(['test']);

      expect(mockEmbedContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: { outputDimensionality: 768 },
        }),
      );
    });
  });

  describe('Custom EMBEDDING_ENDPOINT fallback', () => {
    it('should use custom endpoint when configured', async () => {
      mockConfig.embeddingEndpoint = 'https://embeddings.example.com/v1/embed';

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ embeddings: [new Array(768).fill(0.2)] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const adapter = createEmbeddingAdapter();
      const result = await adapter.embed(['test text']);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://embeddings.example.com/v1/embed',
        expect.objectContaining({
          method: 'POST',
          redirect: 'error',
        }),
      );
      expect(result).toHaveLength(1);
      expect(mockEmbedContent).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('should reject invalid endpoint URL', () => {
      mockConfig.embeddingEndpoint = 'http://evil.com/embed';

      expect(() => createEmbeddingAdapter()).toThrow(
        'EMBEDDING_ENDPOINT must use HTTPS or be a whitelisted internal address',
      );
    });

    it('should allow localhost endpoint', () => {
      mockConfig.embeddingEndpoint = 'http://localhost:8080/embed';

      expect(() => createEmbeddingAdapter()).not.toThrow();
    });
  });

  describe('Non-blocking behavior', () => {
    it('should propagate errors (caller catches for non-blocking)', async () => {
      mockEmbedContent.mockRejectedValueOnce(new Error('Vertex AI unavailable'));

      const adapter = createEmbeddingAdapter();

      await expect(adapter.embed(['test'])).rejects.toThrow('Vertex AI unavailable');
    });

    it('should throw on mismatched embedding count', async () => {
      mockEmbedContent.mockResolvedValueOnce({
        embeddings: makeEmbeddings(1), // Returns 1 but we sent 2 texts
      });

      const adapter = createEmbeddingAdapter();

      // chunkText may produce different number of chunks, so this checks the validation
      await expect(adapter.embed(['text one', 'text two'])).rejects.toThrow();
    });
  });

  describe('Text chunking integration', () => {
    it('should chunk long texts and average embeddings', async () => {
      // Create text that will be split into 2+ chunks (~4000 chars)
      const longText = 'Meeting discussion about project milestones and deadlines. '.repeat(80);

      // Mock enough embeddings for the chunks
      mockEmbedContent.mockImplementation(({ contents }: { contents: { parts: { text: string }[] }[] }) => {
        return Promise.resolve({
          embeddings: makeEmbeddings(contents.length),
        });
      });

      const adapter = createEmbeddingAdapter();
      const result = await adapter.embed([longText]);

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveLength(768);
    });

    it('should return zero vector for empty text', async () => {
      mockEmbedContent.mockResolvedValueOnce({
        embeddings: [],
      });

      const adapter = createEmbeddingAdapter();
      const result = await adapter.embed(['']);

      expect(result).toHaveLength(1);
      // Zero vector for empty text (no chunks)
      expect(result[0].every((v: number) => v === 0)).toBe(true);
    });
  });
});
