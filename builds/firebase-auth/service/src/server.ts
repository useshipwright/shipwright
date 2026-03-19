import { buildApp } from './app.js';
import { composeDependencies } from './composition-root.js';
import { config } from './infra/config.js';

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection', reason);
  process.exit(1);
});

async function main(): Promise<void> {
  const deps = await composeDependencies();
  const app = await buildApp(deps);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down');
    const timer = setTimeout(() => {
      app.log.error('Shutdown timed out, forcing exit');
      process.exit(1);
    }, config.shutdownTimeout);

    try {
      await app.close();
      await deps.firebaseAdapter.shutdown();
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
