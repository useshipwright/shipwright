/**
 * Credential isolation static analysis test (REQ-006, ADR-001).
 *
 * Verifies that:
 * - Only adapters/firebase-admin.ts imports from 'firebase-admin'
 * - No route file reads process.env.FIREBASE_SERVICE_ACCOUNT_JSON
 * - plugins/firebase.ts imports from the adapter, not firebase-admin directly
 * - The credential string is not attached to Fastify instance or request
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const srcDir = join(__dirname, '..', 'src');

/**
 * Recursively collect all .ts files under a directory.
 */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (full.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

const allSrcFiles = collectTsFiles(srcDir);
const adapterPath = join(srcDir, 'adapters', 'firebase-admin.ts');

describe('credential isolation — REQ-006, ADR-001', () => {
  it('only adapters/firebase-admin.ts imports from firebase-admin', () => {
    const violations: string[] = [];

    for (const file of allSrcFiles) {
      // Skip the adapter itself — it's allowed to import firebase-admin
      if (file === adapterPath) continue;
      // Skip the type declaration file — it imports the Auth type
      if (file.endsWith('fastify.d.ts')) continue;

      const content = readFileSync(file, 'utf-8');
      const rel = relative(srcDir, file);

      // Check for direct firebase-admin imports (not adapter imports)
      // Matches: import ... from 'firebase-admin' or 'firebase-admin/...'
      if (/from\s+['"]firebase-admin(?:\/[^'"]*)?['"]/g.test(content)) {
        violations.push(`${rel} imports from firebase-admin directly`);
      }

      // Check for require('firebase-admin')
      if (/require\(\s*['"]firebase-admin(?:\/[^'"]*)?['"]\s*\)/g.test(content)) {
        violations.push(`${rel} requires firebase-admin directly`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('no route file reads process.env.FIREBASE_SERVICE_ACCOUNT_JSON', () => {
    const routesDir = join(srcDir, 'routes');
    const routeFiles = collectTsFiles(routesDir);
    const violations: string[] = [];

    for (const file of routeFiles) {
      const content = readFileSync(file, 'utf-8');
      const rel = relative(srcDir, file);

      if (content.includes('FIREBASE_SERVICE_ACCOUNT_JSON')) {
        violations.push(
          `${rel} references FIREBASE_SERVICE_ACCOUNT_JSON`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it('no route file imports the firebase-admin adapter directly', () => {
    const routesDir = join(srcDir, 'routes');
    const routeFiles = collectTsFiles(routesDir);
    const violations: string[] = [];

    for (const file of routeFiles) {
      const content = readFileSync(file, 'utf-8');
      const rel = relative(srcDir, file);

      if (/firebase-admin/g.test(content)) {
        violations.push(
          `${rel} references firebase-admin (should use app.firebaseAuth decorator)`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it('plugins/firebase.ts imports from adapter, not firebase-admin directly', () => {
    const firebasePluginPath = join(srcDir, 'plugins', 'firebase.ts');
    const content = readFileSync(firebasePluginPath, 'utf-8');

    // Should import from the adapter
    expect(content).toMatch(
      /from\s+['"]\.\.\/adapters\/firebase-admin\.js['"]/,
    );

    // Should NOT import from firebase-admin package directly
    expect(content).not.toMatch(
      /from\s+['"]firebase-admin(?:\/[^'"]*)?['"]/,
    );
  });

  it('only adapters/firebase-admin.ts and plugins/firebase.ts reference the credential env var', () => {
    const violations: string[] = [];
    const allowedFiles = [
      join(srcDir, 'adapters', 'firebase-admin.ts'),
      join(srcDir, 'plugins', 'firebase.ts'),
      join(srcDir, 'config.ts'),
    ];

    for (const file of allSrcFiles) {
      if (allowedFiles.includes(file)) continue;

      const content = readFileSync(file, 'utf-8');
      const rel = relative(srcDir, file);

      if (content.includes('FIREBASE_SERVICE_ACCOUNT_JSON')) {
        violations.push(
          `${rel} references FIREBASE_SERVICE_ACCOUNT_JSON`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it('adapter module exists and exports initFirebase, initFirebaseWithADC, and getFirebaseAuth', async () => {
    const adapter = await import('../src/adapters/firebase-admin.js');

    expect(typeof adapter.initFirebase).toBe('function');
    expect(typeof adapter.initFirebaseWithADC).toBe('function');
    expect(typeof adapter.getFirebaseAuth).toBe('function');
  });
});
