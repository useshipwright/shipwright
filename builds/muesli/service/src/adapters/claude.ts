/**
 * Claude adapter implementation (ADR-005).
 *
 * Wraps the Anthropic SDK to provide a typed generate method for note generation,
 * Q&A, and meeting prep prompts. Implements 2x retry with graceful degradation,
 * supports Sonnet (default) and Opus model selection, and logs all calls with
 * model, token counts, latency, and estimated cost.
 *
 * Secrets (ANTHROPIC_API_KEY) are read from config, never hardcoded or included
 * in prompt content (threat model: Anthropic API key exposure in prompts).
 */

import Anthropic from '@anthropic-ai/sdk';

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ClaudeAdapter, ClaudeOptions, ClaudeResponse } from '../types/adapters.js';

export type { ClaudeAdapter } from '../types/adapters.js';

const MODEL_MAP: Record<NonNullable<ClaudeOptions['model']>, string> = {
  sonnet: 'claude-sonnet-4-20250514',
  opus: 'claude-opus-4-20250514',
};

// Anthropic pricing per million tokens (as of 2025)
const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
};

const DEFAULT_MAX_TOKENS = 4096;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

function isTransientError(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    // Retry on rate limits, server errors, and overloaded
    return err.status === 429 || err.status === 500 || err.status === 503 || err.status === 529;
  }
  // Retry on network errors
  if (err instanceof Anthropic.APIConnectionError) {
    return true;
  }
  return false;
}

function estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  const rates = COST_PER_MILLION[modelId];
  if (!rates) return 0;
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createClaudeAdapter(): ClaudeAdapter {
  const client = new Anthropic({
    apiKey: config.anthropicApiKey,
  });

  return {
    async generate(prompt: string, options?: ClaudeOptions): Promise<ClaudeResponse> {
      const modelKey = options?.model ?? 'sonnet';
      const modelId = MODEL_MAP[modelKey];
      const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
      const temperature = options?.temperature;

      let lastError: unknown;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const startMs = Date.now();

        try {
          const response = await client.messages.create({
            model: modelId,
            max_tokens: maxTokens,
            ...(temperature !== undefined ? { temperature } : {}),
            messages: [{ role: 'user', content: prompt }],
          });

          const latencyMs = Date.now() - startMs;
          const inputTokens = response.usage.input_tokens;
          const outputTokens = response.usage.output_tokens;
          const cost = estimateCost(modelId, inputTokens, outputTokens);

          const text = response.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');

          logger.info(
            {
              model: modelId,
              inputTokens,
              outputTokens,
              latencyMs,
              estimatedCost: cost.toFixed(6),
              attempt,
            },
            'Claude API call completed',
          );

          return {
            text,
            model: modelId,
            inputTokens,
            outputTokens,
            latencyMs,
          };
        } catch (err) {
          lastError = err;
          const latencyMs = Date.now() - startMs;

          logger.warn(
            {
              err,
              model: modelId,
              attempt,
              maxRetries: MAX_RETRIES,
              latencyMs,
            },
            'Claude API call failed',
          );

          if (attempt < MAX_RETRIES && isTransientError(err)) {
            await sleep(RETRY_DELAY_MS * attempt);
            continue;
          }

          break;
        }
      }

      const message =
        lastError instanceof Error ? lastError.message : 'Claude API call failed after retries';

      throw new Error(`Claude adapter error: ${message}`, { cause: lastError });
    },
  };
}
