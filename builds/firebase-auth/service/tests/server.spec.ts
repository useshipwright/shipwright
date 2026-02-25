/**
 * Tests for the server entry point (server.ts).
 *
 * server.ts auto-invokes main() on import, so we:
 *   1. Mock buildApp() to return a fake Fastify instance
 *   2. Spy on process.on / process.exit
 *   3. Dynamically import server.ts per test (vi.resetModules between tests)
 *
 * Verifies:
 * - PORT defaults to 8080 when env var not set
 * - Custom PORT from environment variable
 * - SIGTERM / SIGINT handlers registered for graceful shutdown
 * - buildApp failure prevents server start
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture signal handler registrations
type SignalHandler = (...args: unknown[]) => void;
const signalHandlers: Record<string, SignalHandler[]> = {};

const mockListen = vi.fn();
const mockClose = vi.fn();
const mockLogInfo = vi.fn();
const mockLogError = vi.fn();

const fakeApp = {
  listen: mockListen,
  close: mockClose,
  log: {
    info: mockLogInfo,
    error: mockLogError,
  },
};

const mockBuildApp = vi.fn();

vi.mock('../src/app.js', () => ({
  buildApp: (...args: unknown[]) => mockBuildApp(...args),
}));

describe('server.ts', () => {
  let savedPort: string | undefined;
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();

    savedPort = process.env.PORT;

    // Track signal handler registrations
    for (const key of Object.keys(signalHandlers)) {
      delete signalHandlers[key];
    }

    processOnSpy = vi.spyOn(process, 'on').mockImplementation(
      (event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'SIGTERM' || event === 'SIGINT' || event === 'uncaughtException' || event === 'unhandledRejection') {
          if (!signalHandlers[event]) signalHandlers[event] = [];
          signalHandlers[event].push(handler as SignalHandler);
        }
        return process;
      },
    );

    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as never);

    // Default: buildApp resolves with fake app, listen resolves
    mockBuildApp.mockResolvedValue(fakeApp);
    mockListen.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (savedPort !== undefined) {
      process.env.PORT = savedPort;
    } else {
      delete process.env.PORT;
    }
    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  async function importServer(): Promise<void> {
    await import('../src/server.js');
    // Give the async main() a tick to complete
    await new Promise((r) => setTimeout(r, 10));
  }

  it('defaults to port 8080 when PORT env var is not set', async () => {
    delete process.env.PORT;

    await importServer();

    expect(mockListen).toHaveBeenCalledWith(
      expect.objectContaining({ port: 8080, host: '0.0.0.0' }),
    );
  });

  it('reads PORT from environment variable', async () => {
    process.env.PORT = '3000';

    await importServer();

    expect(mockListen).toHaveBeenCalledWith(
      expect.objectContaining({ port: 3000, host: '0.0.0.0' }),
    );
  });

  it('registers SIGTERM handler for graceful shutdown', async () => {
    delete process.env.PORT;

    await importServer();

    expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(signalHandlers['SIGTERM']).toBeDefined();
    expect(signalHandlers['SIGTERM'].length).toBeGreaterThan(0);
  });

  it('registers SIGINT handler for graceful shutdown', async () => {
    delete process.env.PORT;

    await importServer();

    expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(signalHandlers['SIGINT']).toBeDefined();
    expect(signalHandlers['SIGINT'].length).toBeGreaterThan(0);
  });

  it('SIGTERM handler calls app.close() for graceful shutdown', async () => {
    delete process.env.PORT;

    await importServer();

    // Invoke the SIGTERM handler
    const handler = signalHandlers['SIGTERM'][0];
    await handler();
    await new Promise((r) => setTimeout(r, 10));

    expect(mockClose).toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'SIGTERM' }),
      expect.any(String),
    );
  });

  it('SIGINT handler calls app.close() for graceful shutdown', async () => {
    delete process.env.PORT;

    await importServer();

    const handler = signalHandlers['SIGINT'][0];
    await handler();
    await new Promise((r) => setTimeout(r, 10));

    expect(mockClose).toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'SIGINT' }),
      expect.any(String),
    );
  });

  it('calls buildApp() to create the Fastify instance', async () => {
    delete process.env.PORT;

    await importServer();

    expect(mockBuildApp).toHaveBeenCalledOnce();
  });

  it('registers uncaughtException handler that logs and exits', async () => {
    delete process.env.PORT;

    await importServer();

    expect(processOnSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    expect(signalHandlers['uncaughtException']).toBeDefined();

    const handler = signalHandlers['uncaughtException'][0];
    const fakeError = new Error('unexpected crash');
    handler(fakeError);

    expect(mockLogError).toHaveBeenCalledWith(
      { err: fakeError },
      'Uncaught exception, shutting down',
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('registers unhandledRejection handler that logs and exits', async () => {
    delete process.env.PORT;

    await importServer();

    expect(processOnSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    expect(signalHandlers['unhandledRejection']).toBeDefined();

    const handler = signalHandlers['unhandledRejection'][0];
    const fakeReason = new Error('unhandled promise');
    handler(fakeReason);

    expect(mockLogError).toHaveBeenCalledWith(
      { err: fakeReason },
      'Unhandled rejection, shutting down',
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('logs error and exits with code 1 when listen() fails', async () => {
    delete process.env.PORT;
    const listenError = new Error('EADDRINUSE');
    mockListen.mockRejectedValue(listenError);

    await importServer();

    expect(mockLogError).toHaveBeenCalledWith(listenError);
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
