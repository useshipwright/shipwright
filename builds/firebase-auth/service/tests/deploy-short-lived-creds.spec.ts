import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Static analysis tests for deploy.sh — verifies short-lived credential
 * enforcement per ADR-020 and threat model "Privilege Escalation via
 * Operator Over-Provisioning" mitigation.
 *
 * Operators MUST use `gcloud auth login` (short-lived OAuth tokens), not
 * exported service account keys. The deploy script detects the credential
 * type and warns if a service account is being used interactively.
 */

const DEPLOY_SCRIPT_PATH = resolve(__dirname, '../scripts/deploy.sh');
const deployScript = readFileSync(DEPLOY_SCRIPT_PATH, 'utf-8');

describe('deploy.sh — short-lived credentials (ADR-020)', () => {
  describe('credential type detection', () => {
    it('references ADR-020 in the credential check section', () => {
      expect(deployScript).toContain('ADR-020');
    });

    it('checks the active gcloud account identity', () => {
      expect(deployScript).toContain('gcloud auth list');
    });

    it('detects service account credentials via .iam.gserviceaccount.com suffix', () => {
      expect(deployScript).toContain('.iam.gserviceaccount.com');
    });

    it('warns operators when using service account credentials', () => {
      expect(deployScript).toMatch(/service account.*long-lived/i);
    });

    it('recommends gcloud auth login for operators', () => {
      expect(deployScript).toContain('gcloud auth login');
    });

    it('confirms short-lived credentials when user account detected', () => {
      expect(deployScript).toMatch(/short-lived credentials/i);
    });
  });

  describe('CI/CD guidance', () => {
    it('recommends Workload Identity Federation for CI/CD', () => {
      expect(deployScript).toMatch(/Workload Identity Federation/i);
    });

    it('warns against exported keys in CI/CD', () => {
      expect(deployScript).toMatch(/exported.*keys/i);
    });
  });

  describe('credential check ordering', () => {
    it('validates credentials before any IAM or deploy operations', () => {
      const credCheckIndex = deployScript.indexOf('ACTIVE_ACCOUNT');
      const phase0gIndex = deployScript.indexOf('Phase 0g');
      const phase1Index = deployScript.indexOf('Phase 1:');

      expect(credCheckIndex).toBeGreaterThan(-1);
      expect(phase0gIndex).toBeGreaterThan(-1);
      expect(phase1Index).toBeGreaterThan(-1);
      expect(credCheckIndex).toBeLessThan(phase0gIndex);
      expect(credCheckIndex).toBeLessThan(phase1Index);
    });
  });

});
