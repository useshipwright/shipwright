import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Static analysis tests for deploy.sh — verifies Artifact Analysis
 * (vulnerability scanning) configuration per threat model "Container
 * Image Tampering" mitigation.
 *
 * These tests read the deploy script as text and verify that it enables
 * and checks Container Analysis / Container Scanning APIs and reviews
 * vulnerability scan results before deployment.
 */

const DEPLOY_SCRIPT_PATH = resolve(__dirname, '../scripts/deploy.sh');
const deployScript = readFileSync(DEPLOY_SCRIPT_PATH, 'utf-8');

describe('deploy.sh — Artifact Analysis / vulnerability scanning', () => {
  describe('API enablement checks', () => {
    it('checks if Container Analysis API is enabled', () => {
      expect(deployScript).toContain('containeranalysis.googleapis.com');
    });

    it('checks if Container Scanning API is enabled', () => {
      expect(deployScript).toContain('containerscanning.googleapis.com');
    });

    it('enables Container Analysis API if not already enabled', () => {
      expect(deployScript).toMatch(
        /gcloud services enable containeranalysis\.googleapis\.com/
      );
    });

    it('enables Container Scanning API if not already enabled', () => {
      expect(deployScript).toMatch(
        /gcloud services enable containerscanning\.googleapis\.com/
      );
    });
  });

  describe('vulnerability scan result checking', () => {
    it('queries vulnerability scan results after image push', () => {
      // The script should query vulnerabilities using gcloud artifacts
      expect(deployScript).toContain('gcloud artifacts vulnerabilities list');
    });

    it('checks for CRITICAL severity vulnerabilities', () => {
      expect(deployScript).toContain('CRITICAL');
    });

    it('supports BLOCK_ON_VULNS flag to enforce vulnerability gate', () => {
      expect(deployScript).toContain('BLOCK_ON_VULNS');
    });

    it('vulnerability check occurs before Cloud Run deployment', () => {
      const vulnCheckIndex = deployScript.indexOf(
        'Checking vulnerability scan results'
      );
      const deployIndex = deployScript.indexOf('gcloud run deploy');

      expect(vulnCheckIndex).toBeGreaterThan(-1);
      expect(deployIndex).toBeGreaterThan(-1);
      expect(vulnCheckIndex).toBeLessThan(deployIndex);
    });
  });

  describe('BLOCK_ON_VULNS env var documentation', () => {
    it('documents BLOCK_ON_VULNS in the script header', () => {
      // The header comment block should mention BLOCK_ON_VULNS
      const headerEnd = deployScript.indexOf('set -euo pipefail');
      const header = deployScript.slice(0, headerEnd);
      expect(header).toContain('BLOCK_ON_VULNS');
    });
  });
});
