import type { AppDependencies } from './app.js';
import { config, type AppConfig } from './infra/config.js';
import { firebaseAdapterReady } from './infra/firebase-adapter.js';

// Reject placeholder config values before wiring dependencies.
const PLACEHOLDER_RE = /TODO|PLACEHOLDER|CHANGEME|xxx/i;

function assertNoPlaceholders(cfg: AppConfig): void {
  for (const [key, value] of Object.entries(cfg)) {
    if (typeof value === 'string' && PLACEHOLDER_RE.test(value)) {
      throw new Error(
        `Config key "${key}" contains a placeholder value: "${value}". ` +
          'Replace it with a real value before starting the service.',
      );
    }
  }
}

export async function composeDependencies(): Promise<AppDependencies> {
  // Validate no placeholder values in config
  assertNoPlaceholders(config);

  // Await Firebase adapter initialisation (includes health probe per ADR-004)
  const firebaseAdapter = await firebaseAdapterReady;

  return Object.freeze({
    config,
    firebaseAdapter,
  });
}
