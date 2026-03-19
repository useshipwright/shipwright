import Fastify, { type FastifyInstance } from 'fastify';
import { config, type AppConfig } from './infra/config.js';
import { pinoRedactConfig } from './plugins/log-redactor.js';
import { registerPlugins } from './plugins/index.js';
import { registerRoutes } from './routes/index.js';
import type { FirebaseAdapter } from './domain/types.js';

export interface AppDependencies {
  config: AppConfig;
  firebaseAdapter: FirebaseAdapter;
}

export async function buildApp(deps: Partial<AppDependencies> = {}): Promise<FastifyInstance> {
  const cfg = deps.config ?? config;

  const app = Fastify({
    trustProxy: cfg.trustProxy,
    logger: {
      level: cfg.logLevel,
      redact: pinoRedactConfig,
    },
  });

  await registerPlugins(app, { config: cfg });
  await registerRoutes(app, deps);

  return app;
}
