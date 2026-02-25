import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Static analysis tests for deploy.sh — verifies MFA enforcement
 * guidance per ADR-021 and threat model "Privilege Escalation via
 * Operator Over-Provisioning" mitigation.
 *
 * MFA state cannot be verified programmatically via gcloud. The deploy
 * script ensures the credential type supports MFA (user accounts do,
 * service accounts do not) and documents the Cloud Identity policy
 * requirement.
 */

const DEPLOY_SCRIPT_PATH = resolve(__dirname, '../scripts/deploy.sh');
const deployScript = readFileSync(DEPLOY_SCRIPT_PATH, 'utf-8');

describe('deploy.sh — MFA enforcement (ADR-021)', () => {
  describe('MFA documentation in deploy script', () => {
    it('references ADR-021 in the credential check section', () => {
      expect(deployScript).toContain('ADR-021');
    });

    it('notes that MFA state cannot be verified programmatically', () => {
      expect(deployScript).toMatch(/MFA.*cannot be verified programmatically/i);
    });

    it('notes that service accounts do not support MFA', () => {
      expect(deployScript).toMatch(/[Ss]ervice accounts do not support MFA/);
    });

    it('confirms user accounts support MFA enforcement', () => {
      expect(deployScript).toMatch(/[Uu]ser accounts support MFA/);
    });

    it('references Cloud Identity policy for MFA enforcement', () => {
      expect(deployScript).toMatch(/Cloud Identity/i);
    });
  });

  describe('MFA and credential type integration', () => {
    it('MFA warning is part of the service account credential detection', () => {
      // The MFA warning should appear near the service account detection logic
      const saDetectionIndex = deployScript.indexOf(
        '.iam.gserviceaccount.com'
      );
      const mfaWarningIndex = deployScript.indexOf(
        'do not support MFA'
      );

      expect(saDetectionIndex).toBeGreaterThan(-1);
      expect(mfaWarningIndex).toBeGreaterThan(-1);

      // MFA warning should be within the same credential-check block
      expect(Math.abs(mfaWarningIndex - saDetectionIndex)).toBeLessThan(1500);
    });
  });

});
