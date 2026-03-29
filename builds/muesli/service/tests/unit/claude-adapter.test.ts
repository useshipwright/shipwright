/**
 * Claude adapter unit tests — T-030.
 *
 * Tests the Claude adapter: model selection (Sonnet default, Opus override),
 * logging of model/tokens/latency/cost, 2x retry with graceful degradation,
 * and prompt passthrough.
 *
 * Strategy: Mock @anthropic-ai/sdk via vi.mock (adapter wraps the SDK).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock Anthropic SDK ───────────────────────────────────────────────

const { mockCreate, MockAPIError, MockAPIConnectionError } = vi.hoisted(() => {
  const mockCreate = vi.fn();

  class MockAPIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'APIError';
    }
  }

  class MockAPIConnectionError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'APIConnectionError';
    }
  }

  return { mockCreate, MockAPIError, MockAPIConnectionError };
});

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  (MockAnthropic as Record<string, unknown>).APIError = MockAPIError;
  (MockAnthropic as Record<string, unknown>).APIConnectionError = MockAPIConnectionError;
  return { default: MockAnthropic, APIError: MockAPIError, APIConnectionError: MockAPIConnectionError };
});

vi.mock('../../src/config.js', () => ({
  config: {
    anthropicApiKey: 'test-api-key',
  },
}));

const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
vi.mock('../../src/logger.js', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { createClaudeAdapter } from '../../src/adapters/claude.js';
import type { ClaudeAdapter } from '../../src/types/adapters.js';

// ── Fixtures ─────────────────────────────────────────────────────────

function sdkResponse(overrides?: Partial<{ inputTokens: number; outputTokens: number; text: string }>) {
  return {
    content: [{ type: 'text', text: overrides?.text ?? 'Generated response text' }],
    usage: {
      input_tokens: overrides?.inputTokens ?? 100,
      output_tokens: overrides?.outputTokens ?? 50,
    },
    model: 'claude-sonnet-4-20250514',
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ClaudeAdapter', () => {
  let adapter: ClaudeAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    adapter = createClaudeAdapter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('generate() — model selection', () => {
    it('should use Sonnet model by default', async () => {
      mockCreate.mockResolvedValueOnce(sdkResponse());

      await adapter.generate('Test prompt');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-20250514',
        }),
      );
    });

    it('should use Opus model when specified', async () => {
      mockCreate.mockResolvedValueOnce({
        ...sdkResponse(),
        model: 'claude-opus-4-20250514',
      });

      await adapter.generate('Test prompt', { model: 'opus' });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-opus-4-20250514',
        }),
      );
    });

    it('should pass maxTokens and temperature to SDK', async () => {
      mockCreate.mockResolvedValueOnce(sdkResponse());

      await adapter.generate('Test prompt', { maxTokens: 2048, temperature: 0.5 });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          max_tokens: 2048,
          temperature: 0.5,
        }),
      );
    });

    it('should default maxTokens to 4096', async () => {
      mockCreate.mockResolvedValueOnce(sdkResponse());

      await adapter.generate('Test prompt');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          max_tokens: 4096,
        }),
      );
    });
  });

  describe('generate() — response handling', () => {
    it('should return text, model, tokens, and latency', async () => {
      mockCreate.mockResolvedValueOnce(sdkResponse({ text: 'Hello world', inputTokens: 200, outputTokens: 100 }));

      const result = await adapter.generate('Test');

      expect(result.text).toBe('Hello world');
      expect(result.inputTokens).toBe(200);
      expect(result.outputTokens).toBe(100);
      expect(result.model).toBe('claude-sonnet-4-20250514');
      expect(typeof result.latencyMs).toBe('number');
    });

    it('should concatenate multiple text blocks', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'Part one. ' },
          { type: 'text', text: 'Part two.' },
        ],
        usage: { input_tokens: 50, output_tokens: 20 },
        model: 'claude-sonnet-4-20250514',
      });

      const result = await adapter.generate('Test');

      expect(result.text).toBe('Part one. Part two.');
    });
  });

  describe('generate() — logging', () => {
    it('should log model, tokens, latency, and estimated cost on success', async () => {
      mockCreate.mockResolvedValueOnce(sdkResponse({ inputTokens: 1000, outputTokens: 500 }));

      await adapter.generate('Test');

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-20250514',
          inputTokens: 1000,
          outputTokens: 500,
          estimatedCost: expect.any(String),
          latencyMs: expect.any(Number),
          attempt: 1,
        }),
        'Claude API call completed',
      );
    });

    it('should log warning on failure with attempt info', async () => {
      mockCreate.mockRejectedValueOnce(new Error('Network error'));

      await expect(adapter.generate('Test')).rejects.toThrow();

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-20250514',
          attempt: 1,
          maxRetries: 2,
        }),
        'Claude API call failed',
      );
    });
  });

  describe('generate() — retry with graceful degradation', () => {
    it('should retry on transient 429 error and succeed on second attempt', async () => {
      const transientError = new MockAPIError(429, 'Rate limited');
      mockCreate
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce(sdkResponse());

      const resultPromise = adapter.generate('Test');
      // Advance past retry delay
      await vi.advanceTimersByTimeAsync(2000);
      const result = await resultPromise;

      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(result.text).toBe('Generated response text');
    });

    it('should retry on 500 server error', async () => {
      const serverError = new MockAPIError(500, 'Internal Server Error');
      mockCreate
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce(sdkResponse());

      const resultPromise = adapter.generate('Test');
      await vi.advanceTimersByTimeAsync(2000);
      const result = await resultPromise;

      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(result.text).toBe('Generated response text');
    });

    it('should NOT retry on non-transient 400 error', async () => {
      const badRequest = new MockAPIError(400, 'Bad request');
      mockCreate.mockRejectedValueOnce(badRequest);

      await expect(adapter.generate('Test')).rejects.toThrow('Claude adapter error');
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('should throw after MAX_RETRIES exhausted', async () => {
      vi.useRealTimers();
      const transientError = new MockAPIError(503, 'Service unavailable');
      mockCreate
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError);

      await expect(adapter.generate('Test')).rejects.toThrow('Claude adapter error');
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });
  });

  describe('generate() — prompt passthrough', () => {
    it('should pass the prompt as user message content', async () => {
      mockCreate.mockResolvedValueOnce(sdkResponse());

      const longPrompt = 'You are a meeting assistant.\n\n<transcript>\n[00:00] Speaker A: Hello\n</transcript>';
      await adapter.generate(longPrompt);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: 'user', content: longPrompt }],
        }),
      );
    });
  });
});
