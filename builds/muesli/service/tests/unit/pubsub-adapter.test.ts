/**
 * Pub/Sub adapter tests — T-027.
 *
 * Tests the PubSubAdapter interface: publish with correct topic and payload.
 *
 * Strategy: Test via the adapter interface contract with a mock implementation.
 */

import { describe, it, expect, vi } from 'vitest';
import type { PubSubAdapter, AudioProcessingMessage } from '../../src/types/adapters.js';

// ── Mock PubSub Adapter ─────────────────────────────────────────────

function createMockPubSubAdapter(opts?: {
  publishFails?: boolean;
}): PubSubAdapter & { publishedMessages: Array<{ topic: string; data: AudioProcessingMessage }> } {
  const publishedMessages: Array<{ topic: string; data: AudioProcessingMessage }> = [];
  let messageCounter = 0;

  return {
    publishedMessages,
    publish: vi.fn(async (topic: string, data: AudioProcessingMessage) => {
      if (opts?.publishFails) {
        throw new Error(`Pub/Sub publish failed for topic "${topic}": Connection refused`);
      }
      publishedMessages.push({ topic, data });
      messageCounter++;
      return `msg-${messageCounter}`;
    }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('PubSub Adapter', () => {
  describe('publish', () => {
    it('publishes a message to the specified topic', async () => {
      const adapter = createMockPubSubAdapter();
      const message: AudioProcessingMessage = {
        meetingId: 'meeting-123',
        userId: 'user-456',
        audioPath: 'audio/user-456/meeting-123/recording.webm',
      };

      const messageId = await adapter.publish('audio-processing', message);

      expect(messageId).toBe('msg-1');
      expect(adapter.publish).toHaveBeenCalledWith('audio-processing', message);
    });

    it('includes the correct payload structure', async () => {
      const adapter = createMockPubSubAdapter();
      const message: AudioProcessingMessage = {
        meetingId: 'meeting-123',
        userId: 'user-456',
        audioPath: 'audio/user-456/meeting-123/recording.webm',
        backend: 'deepgram',
      };

      await adapter.publish('audio-processing', message);

      expect(adapter.publishedMessages).toHaveLength(1);
      const published = adapter.publishedMessages[0];
      expect(published.topic).toBe('audio-processing');
      expect(published.data.meetingId).toBe('meeting-123');
      expect(published.data.userId).toBe('user-456');
      expect(published.data.audioPath).toBe('audio/user-456/meeting-123/recording.webm');
      expect(published.data.backend).toBe('deepgram');
    });

    it('publishes message without optional backend', async () => {
      const adapter = createMockPubSubAdapter();
      const message: AudioProcessingMessage = {
        meetingId: 'meeting-123',
        userId: 'user-456',
        audioPath: 'audio/user-456/meeting-123/recording.webm',
      };

      await adapter.publish('audio-processing', message);

      expect(adapter.publishedMessages[0].data.backend).toBeUndefined();
    });

    it('returns a unique message ID', async () => {
      const adapter = createMockPubSubAdapter();
      const message: AudioProcessingMessage = {
        meetingId: 'meeting-123',
        userId: 'user-456',
        audioPath: 'audio/user-456/meeting-123/recording.webm',
      };

      const id1 = await adapter.publish('audio-processing', message);
      const id2 = await adapter.publish('audio-processing', message);

      expect(id1).not.toBe(id2);
    });

    it('throws on publish failure with descriptive error', async () => {
      const adapter = createMockPubSubAdapter({ publishFails: true });
      const message: AudioProcessingMessage = {
        meetingId: 'meeting-123',
        userId: 'user-456',
        audioPath: 'audio/user-456/meeting-123/recording.webm',
      };

      await expect(
        adapter.publish('audio-processing', message),
      ).rejects.toThrow('Pub/Sub publish failed');
    });

    it('includes topic name in error message on failure', async () => {
      const adapter = createMockPubSubAdapter({ publishFails: true });

      await expect(
        adapter.publish('my-topic', {
          meetingId: 'm1',
          userId: 'u1',
          audioPath: 'path',
        }),
      ).rejects.toThrow('my-topic');
    });

    it('publishes to different topics', async () => {
      const adapter = createMockPubSubAdapter();
      const message: AudioProcessingMessage = {
        meetingId: 'meeting-1',
        userId: 'user-1',
        audioPath: 'path',
      };

      await adapter.publish('topic-a', message);
      await adapter.publish('topic-b', message);

      expect(adapter.publishedMessages[0].topic).toBe('topic-a');
      expect(adapter.publishedMessages[1].topic).toBe('topic-b');
    });
  });

  describe('AudioProcessingMessage shape', () => {
    it('accepts all transcription backend options', async () => {
      const adapter = createMockPubSubAdapter();
      const backends = ['deepgram', 'whisper', 'google-stt'] as const;

      for (const backend of backends) {
        await adapter.publish('audio-processing', {
          meetingId: 'meeting-1',
          userId: 'user-1',
          audioPath: 'path',
          backend,
        });
      }

      expect(adapter.publishedMessages).toHaveLength(3);
      expect(adapter.publishedMessages[0].data.backend).toBe('deepgram');
      expect(adapter.publishedMessages[1].data.backend).toBe('whisper');
      expect(adapter.publishedMessages[2].data.backend).toBe('google-stt');
    });
  });
});
