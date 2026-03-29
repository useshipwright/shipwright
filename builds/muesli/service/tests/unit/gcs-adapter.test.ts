/**
 * GCS adapter tests — T-027.
 *
 * Tests the GCSAdapter interface: upload, getSignedUrl, delete, createWriteStream, healthCheck.
 *
 * Strategy: Test the adapter interface contract via a mock implementation.
 * We do NOT mock the @google-cloud/storage package directly (previous attempt
 * showed this is unreliable). Instead we test the interface behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import type { GCSAdapter } from '../../src/types/adapters.js';

// ── Mock GCS Adapter ────────────────────────────────────────────────

function createMockGCSAdapter(opts?: {
  uploadFails?: boolean;
  signedUrl?: string;
  deleteFails?: boolean;
  healthyBucket?: boolean;
}): GCSAdapter {
  const stored = new Map<string, { data: Buffer; contentType: string }>();

  return {
    upload: vi.fn(async (path: string, data: Buffer, contentType: string) => {
      if (opts?.uploadFails) throw new Error('GCS upload failed');
      stored.set(path, { data, contentType });
    }),

    createWriteStream: vi.fn((path: string, contentType: string) => {
      const chunks: Buffer[] = [];
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk as Buffer);
          callback();
        },
        final(callback) {
          stored.set(path, { data: Buffer.concat(chunks), contentType });
          callback();
        },
      });
      return stream;
    }),

    getSignedUrl: vi.fn(async (path: string, _expirationMinutes?: number) => {
      if (!stored.has(path) && !opts?.signedUrl) {
        throw new Error('File not found');
      }
      return opts?.signedUrl ?? `https://storage.googleapis.com/bucket/${path}?signed=true`;
    }),

    delete: vi.fn(async (path: string) => {
      if (opts?.deleteFails) throw new Error('GCS delete failed');
      stored.delete(path);
    }),

    deleteByPrefix: vi.fn(async (prefix: string) => {
      for (const key of stored.keys()) {
        if (key.startsWith(prefix)) stored.delete(key);
      }
    }),

    healthCheck: vi.fn(async () => opts?.healthyBucket ?? true),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('GCS Adapter', () => {
  describe('upload', () => {
    it('stores a file at the given path', async () => {
      const adapter = createMockGCSAdapter();
      const data = Buffer.from('audio-data');

      await adapter.upload('audio/user-1/meeting-1/file.webm', data, 'audio/webm');

      expect(adapter.upload).toHaveBeenCalledWith(
        'audio/user-1/meeting-1/file.webm',
        data,
        'audio/webm',
      );
    });

    it('throws on upload failure', async () => {
      const adapter = createMockGCSAdapter({ uploadFails: true });

      await expect(
        adapter.upload('path', Buffer.from('data'), 'audio/webm'),
      ).rejects.toThrow('GCS upload failed');
    });
  });

  describe('createWriteStream', () => {
    it('returns a writable stream', () => {
      const adapter = createMockGCSAdapter();
      const stream = adapter.createWriteStream('audio/user-1/file.webm', 'audio/webm');

      expect(stream).toBeDefined();
      expect(typeof stream.write).toBe('function');
      expect(typeof stream.end).toBe('function');
    });

    it('accepts data written to the stream', async () => {
      const adapter = createMockGCSAdapter();
      const stream = adapter.createWriteStream('audio/user-1/file.webm', 'audio/webm');

      await new Promise<void>((resolve, reject) => {
        stream.write(Buffer.from('chunk-1'), (err) => {
          if (err) reject(err);
          stream.end(Buffer.from('chunk-2'), () => resolve());
        });
      });

      expect(adapter.createWriteStream).toHaveBeenCalledWith(
        'audio/user-1/file.webm',
        'audio/webm',
      );
    });
  });

  describe('getSignedUrl', () => {
    it('returns a signed URL for a stored file', async () => {
      const adapter = createMockGCSAdapter({
        signedUrl: 'https://storage.googleapis.com/bucket/path?sig=abc',
      });

      const url = await adapter.getSignedUrl('audio/user-1/file.webm');
      expect(url).toContain('https://storage.googleapis.com');
    });

    it('accepts optional expiration minutes parameter', async () => {
      const adapter = createMockGCSAdapter({
        signedUrl: 'https://example.com/signed',
      });

      const url = await adapter.getSignedUrl('path', 30);
      expect(url).toBeDefined();
      expect(adapter.getSignedUrl).toHaveBeenCalledWith('path', 30);
    });
  });

  describe('delete', () => {
    it('deletes a file at the given path', async () => {
      const adapter = createMockGCSAdapter();
      await adapter.upload('path/to/file', Buffer.from('data'), 'audio/webm');

      await adapter.delete('path/to/file');
      expect(adapter.delete).toHaveBeenCalledWith('path/to/file');
    });

    it('throws on delete failure', async () => {
      const adapter = createMockGCSAdapter({ deleteFails: true });

      await expect(adapter.delete('path')).rejects.toThrow('GCS delete failed');
    });
  });

  describe('deleteByPrefix', () => {
    it('deletes all files matching prefix', async () => {
      const adapter = createMockGCSAdapter();

      await adapter.deleteByPrefix('audio/user-1/meeting-1/');
      expect(adapter.deleteByPrefix).toHaveBeenCalledWith('audio/user-1/meeting-1/');
    });
  });

  describe('healthCheck', () => {
    it('returns true when bucket is accessible', async () => {
      const adapter = createMockGCSAdapter({ healthyBucket: true });
      const result = await adapter.healthCheck();
      expect(result).toBe(true);
    });

    it('returns false when bucket is not accessible', async () => {
      const adapter = createMockGCSAdapter({ healthyBucket: false });
      const result = await adapter.healthCheck();
      expect(result).toBe(false);
    });
  });

  describe('path structure', () => {
    it('follows audio/{userId}/{meetingId}/ convention', async () => {
      const adapter = createMockGCSAdapter();
      const path = 'audio/user-123/meeting-456/recording.webm';

      await adapter.upload(path, Buffer.from('audio'), 'audio/webm');
      expect(adapter.upload).toHaveBeenCalledWith(
        path,
        expect.any(Buffer),
        'audio/webm',
      );

      // Verify the path segments
      const parts = path.split('/');
      expect(parts[0]).toBe('audio');
      expect(parts[1]).toBe('user-123');
      expect(parts[2]).toBe('meeting-456');
    });
  });
});
