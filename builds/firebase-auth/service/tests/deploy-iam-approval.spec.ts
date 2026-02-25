import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Static analysis tests for deploy.sh — verifies the IAM permission diff
 * approval step per ADR-023 and threat model "Privilege Escalation via
 * Operator Over-Provisioning" mitigation.
 *
 * These tests read the deploy script as text and verify that it includes
 * an interactive approval gate with audit trail before IAM changes.
 */

const DEPLOY_SCRIPT_PATH = resolve(__dirname, '../scripts/deploy.sh');
const deployScript = readFileSync(DEPLOY_SCRIPT_PATH, 'utf-8');

describe('deploy.sh — IAM permission diff approval (ADR-023)', () => {
  describe('approval gate', () => {
    it('includes Phase 0g for IAM permission diff review', () => {
      expect(deployScript).toContain('Phase 0g');
      expect(deployScript).toContain('ADR-023');
    });

    it('prompts operator for interactive approval', () => {
      expect(deployScript).toContain('Approve IAM changes?');
    });

    it('defaults to deny (y/N prompt)', () => {
      // The prompt must show [y/N] indicating N is the default
      expect(deployScript).toContain('[y/N]');
    });

    it('aborts deployment if operator denies approval', () => {
      expect(deployScript).toMatch(
        /IAM changes not approved.*deployment aborted/i
      );
    });

    it('detects non-interactive terminal and requires AUTO_APPROVE_IAM', () => {
      expect(deployScript).toContain('Non-interactive terminal detected');
      expect(deployScript).toContain('AUTO_APPROVE_IAM');
    });
  });

  describe('CI/CD auto-approve mode', () => {
    it('supports AUTO_APPROVE_IAM environment variable', () => {
      expect(deployScript).toContain('AUTO_APPROVE_IAM');
    });

    it('documents AUTO_APPROVE_IAM in the script header', () => {
      const headerEnd = deployScript.indexOf('set -euo pipefail');
      const header = deployScript.slice(0, headerEnd);
      expect(header).toContain('AUTO_APPROVE_IAM');
    });

    it('logs a warning when auto-approving', () => {
      expect(deployScript).toMatch(/auto-approving IAM changes/i);
    });
  });

  describe('skip mode', () => {
    it('supports SKIP_IAM_DIFF environment variable', () => {
      expect(deployScript).toContain('SKIP_IAM_DIFF');
    });

    it('documents SKIP_IAM_DIFF in the script header', () => {
      const headerEnd = deployScript.indexOf('set -euo pipefail');
      const header = deployScript.slice(0, headerEnd);
      expect(header).toContain('SKIP_IAM_DIFF');
    });
  });

  describe('audit trail', () => {
    it('writes an audit log entry on approval', () => {
      expect(deployScript).toContain('iam-audit.log');
    });

    it('creates the audit log directory', () => {
      expect(deployScript).toContain('mkdir -p');
      expect(deployScript).toContain('AUDIT_LOG_DIR');
    });

    it('records the operator identity in the audit log', () => {
      // The audit entry should include the operator account
      expect(deployScript).toMatch(/operator.*ACTIVE_ACCOUNT/i);
    });

    it('records a timestamp in the audit log', () => {
      expect(deployScript).toContain('AUDIT_TIMESTAMP');
    });

    it('records the approval mode in the audit log', () => {
      // Should distinguish between interactive, auto-approved, and denied
      expect(deployScript).toContain('APPROVAL_MODE');
    });

    it('writes audit entry as JSON for machine parsing', () => {
      expect(deployScript).toContain('json.dumps');
    });
  });

  describe('ordering', () => {
    it('runs before Phase 0b (Artifact Registry IAM audit)', () => {
      const phase0gIndex = deployScript.indexOf('Phase 0g');
      const phase0bIndex = deployScript.indexOf('Phase 0b');

      expect(phase0gIndex).toBeGreaterThan(-1);
      expect(phase0bIndex).toBeGreaterThan(-1);
      expect(phase0gIndex).toBeLessThan(phase0bIndex);
    });

    it('runs before Phase 0d (per-secret IAM binding)', () => {
      const phase0gIndex = deployScript.indexOf('Phase 0g');
      const phase0dIndex = deployScript.indexOf('Phase 0d');

      expect(phase0gIndex).toBeGreaterThan(-1);
      expect(phase0dIndex).toBeGreaterThan(-1);
      expect(phase0gIndex).toBeLessThan(phase0dIndex);
    });

    it('runs before Phase 0f (custom roles creation)', () => {
      const phase0gIndex = deployScript.indexOf('Phase 0g');
      const phase0fIndex = deployScript.indexOf('Phase 0f');

      expect(phase0gIndex).toBeGreaterThan(-1);
      expect(phase0fIndex).toBeGreaterThan(-1);
      expect(phase0gIndex).toBeLessThan(phase0fIndex);
    });

    it('runs before Phase 1 (container build)', () => {
      const phase0gIndex = deployScript.indexOf('Phase 0g');
      const phase1Index = deployScript.indexOf('Phase 1:');

      expect(phase0gIndex).toBeGreaterThan(-1);
      expect(phase1Index).toBeGreaterThan(-1);
      expect(phase0gIndex).toBeLessThan(phase1Index);
    });
  });

  describe('diff display', () => {
    it('shows the desired IAM state from deploy configuration', () => {
      expect(deployScript).toContain('Desired IAM state');
    });

    it('shows the current GCP state', () => {
      expect(deployScript).toContain('Current GCP state');
    });

    it('displays service account roles', () => {
      expect(deployScript).toContain('roles/secretmanager.secretAccessor');
      expect(deployScript).toContain('roles/logging.logWriter');
      expect(deployScript).toContain('roles/cloudtrace.agent');
    });

    it('displays custom role information when enabled', () => {
      expect(deployScript).toContain('firebaseAuthPackOperator');
      expect(deployScript).toContain('firebaseAuthPackBuilder');
    });
  });
});
