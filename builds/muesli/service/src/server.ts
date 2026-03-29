import { buildApp } from './app.js';
import { config } from './config.js';
import { createDependencies } from './composition-root.js';

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection', reason);
  process.exit(1);
});

async function main(): Promise<void> {
  const deps = createDependencies();
  const app = await buildApp(deps);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down');
    const timer = setTimeout(() => {
      app.log.error('Shutdown timed out, forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs);

    try {
      await app.close();
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
    } finally {
      clearTimeout(timer);
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
