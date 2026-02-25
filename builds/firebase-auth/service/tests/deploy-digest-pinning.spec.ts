import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Static analysis tests for deploy.sh — verifies image digest pinning
 * per ADR-015 and threat model "Container Image Tampering" mitigation.
 *
 * These tests read the deploy script as text and verify that it follows
 * the correct deployment pattern (image@sha256:digest, not image:tag).
 */

const DEPLOY_SCRIPT_PATH = resolve(__dirname, '../scripts/deploy.sh');
const deployScript = readFileSync(DEPLOY_SCRIPT_PATH, 'utf-8');

describe('deploy.sh — image digest pinning (ADR-015)', () => {
  it('resolves image digest via gcloud artifacts docker images describe', () => {
    expect(deployScript).toContain('gcloud artifacts docker images describe');
  });

  it('extracts digest using image_summary.digest format field', () => {
    expect(deployScript).toContain('image_summary.digest');
  });

  it('constructs a pinned image reference using @sha256 format', () => {
    // The script should build IMAGE_REPO@IMAGE_DIGEST (which contains sha256:...)
    expect(deployScript).toMatch(/PINNED_IMAGE=.*@.*IMAGE_DIGEST/);
  });

  it('deploys to Cloud Run using the digest-pinned image, not the tagged image', () => {
    // Find the gcloud run deploy command and verify it uses PINNED_IMAGE
    const deployCommand = deployScript
      .split('\n')
      .filter(line => line.includes('--image='));

    expect(deployCommand.length).toBeGreaterThan(0);

    for (const line of deployCommand) {
      // Must use PINNED_IMAGE (digest), not TAGGED_IMAGE or FULL_IMAGE (tag)
      expect(line).toContain('PINNED_IMAGE');
      expect(line).not.toContain('TAGGED_IMAGE');
      expect(line).not.toContain('FULL_IMAGE');
    }
  });

  it('fails fast if image digest cannot be resolved', () => {
    // Script should check for empty digest and die
    expect(deployScript).toMatch(/IMAGE_DIGEST.*die|die.*digest/i);
  });

  it('fails fast if gcloud artifacts describe command fails', () => {
    // The gcloud command should have || die error handling
    expect(deployScript).toMatch(
      /gcloud artifacts docker images describe.*\|\| die/s
    );
  });

  it('still tags the image during build (for human readability)', () => {
    // Build phase should use --tag with the tagged image
    expect(deployScript).toMatch(/gcloud builds submit.*--tag=/s);
  });

  it('does not use mutable tags in the deploy command', () => {
    // Extract the gcloud run deploy block
    const lines = deployScript.split('\n');
    const deployStart = lines.findIndex(l => l.includes('gcloud run deploy'));
    expect(deployStart).toBeGreaterThan(-1);

    // Collect the full gcloud run deploy command (multi-line with \)
    let deployBlock = '';
    for (let i = deployStart; i < lines.length; i++) {
      deployBlock += lines[i] + '\n';
      if (!lines[i].trimEnd().endsWith('\\')) break;
    }

    // The --image flag must not reference a tag variable
    expect(deployBlock).not.toMatch(/--image=.*:.*IMAGE_TAG/);
    expect(deployBlock).not.toMatch(/--image=.*:latest/);
  });
});
