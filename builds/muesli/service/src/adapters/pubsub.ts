/**
 * Pub/Sub adapter implementation (ADR-005, ADR-006).
 *
 * Wraps @google-cloud/pubsub. Publishes messages to the audio-processing topic
 * with payloads containing meetingId, userId, audioPath, and backend preference.
 * Used by audio ingestion to trigger async transcription processing.
 *
 * Push subscription configuration (retry, dead-letter) is handled at the
 * infrastructure level, not in application code.
 */

import { PubSub } from '@google-cloud/pubsub';

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { AudioProcessingMessage, PubSubAdapter } from '../types/adapters.js';

export type { PubSubAdapter } from '../types/adapters.js';

export function createPubSubAdapter(): PubSubAdapter {
  const client = new PubSub({
    projectId: config.googleCloudProject,
  });

  return {
    async publish(topic: string, data: AudioProcessingMessage): Promise<string> {
      const topicRef = client.topic(topic);
      const payload = Buffer.from(JSON.stringify(data));

      try {
        const messageId = await topicRef.publishMessage({ data: payload });
        logger.info(
          { topic, meetingId: data.meetingId, messageId },
          'Message published to Pub/Sub',
        );
        return messageId;
      } catch (err) {
        logger.error({ err, topic, meetingId: data.meetingId }, 'Failed to publish to Pub/Sub');
        throw new Error(
          `Pub/Sub publish failed for topic "${topic}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },
  };
}
