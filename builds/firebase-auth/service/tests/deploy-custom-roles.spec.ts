import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Static analysis tests for custom IAM roles per ADR-022 and threat model
 * "Privilege Escalation via Operator Over-Provisioning" mitigation.
 *
 * Verifies:
 * - custom-roles.yaml defines scoped operator and builder roles
 * - deploy.sh creates/updates custom roles from YAML
 */

const DEPLOY_SCRIPT_PATH = resolve(__dirname, '../scripts/deploy.sh');
const deployScript = readFileSync(DEPLOY_SCRIPT_PATH, 'utf-8');

const CUSTOM_ROLES_PATH = resolve(__dirname, '../iam/custom-roles.yaml');
const customRoles = readFileSync(CUSTOM_ROLES_PATH, 'utf-8');

describe('custom IAM roles (ADR-022)', () => {
  describe('custom-roles.yaml — operator role', () => {
    it('defines the firebaseAuthPackOperator role', () => {
      expect(customRoles).toContain('firebaseAuthPackOperator');
    });

    it('includes Cloud Run permissions', () => {
      expect(customRoles).toContain('run.services.create');
      expect(customRoles).toContain('run.services.update');
      expect(customRoles).toContain('run.services.get');
    });

    it('includes Cloud Build permissions', () => {
      expect(customRoles).toContain('cloudbuild.builds.create');
      expect(customRoles).toContain('cloudbuild.builds.get');
    });

    it('includes Secret Manager management permissions', () => {
      expect(customRoles).toContain('secretmanager.secrets.create');
      expect(customRoles).toContain('secretmanager.secrets.setIamPolicy');
    });

    it('excludes secretmanager.versions.access (operator cannot read values)', () => {
      // This is a critical security boundary — operator can manage secrets
      // but not read their values
      expect(customRoles).toContain('secretmanager.versions.access intentionally excluded');
      // Verify the permission itself is NOT in the includedPermissions list
      const operatorSection = customRoles.slice(
        customRoles.indexOf('operator:'),
        customRoles.indexOf('cloud_build_sa:')
      );
      const permissionLines = operatorSection
        .split('\n')
        .filter((l) => l.trim().startsWith('- ') && !l.trim().startsWith('# '));
      const hasAccess = permissionLines.some((l) =>
        l.includes('secretmanager.versions.access')
      );
      expect(hasAccess).toBe(false);
    });

    it('includes IAM permissions for service account management', () => {
      expect(customRoles).toContain('iam.serviceAccounts.actAs');
      expect(customRoles).toContain('iam.serviceAccounts.create');
    });

    it('includes project IAM policy permissions', () => {
      expect(customRoles).toContain('resourcemanager.projects.getIamPolicy');
      expect(customRoles).toContain('resourcemanager.projects.setIamPolicy');
    });

    it('documents which predefined roles it replaces', () => {
      expect(customRoles).toContain('roles/run.admin');
      expect(customRoles).toContain('roles/cloudbuild.builds.editor');
      expect(customRoles).toContain('roles/secretmanager.admin');
      expect(customRoles).toContain('roles/artifactregistry.admin');
      expect(customRoles).toContain('roles/iam.serviceAccountUser');
      expect(customRoles).toContain('roles/resourcemanager.projectIamAdmin');
    });
  });

  describe('custom-roles.yaml — Cloud Build SA role', () => {
    it('defines the firebaseAuthPackBuilder role', () => {
      expect(customRoles).toContain('firebaseAuthPackBuilder');
    });

    it('includes Artifact Registry push permissions', () => {
      expect(customRoles).toContain(
        'artifactregistry.repositories.uploadArtifacts'
      );
    });

    it('includes Cloud Run update permissions but not create/delete', () => {
      const builderSection = customRoles.slice(
        customRoles.indexOf('cloud_build_sa:')
      );
      expect(builderSection).toContain('run.services.update');
      expect(builderSection).toContain('run.services.get');

      // Builder should NOT be able to create or delete services
      const builderPermLines = builderSection
        .split('\n')
        .filter((l) => l.trim().startsWith('- ') && !l.trim().startsWith('# '));
      const hasCreate = builderPermLines.some((l) =>
        l.includes('run.services.create')
      );
      const hasDelete = builderPermLines.some((l) =>
        l.includes('run.services.delete')
      );
      expect(hasCreate).toBe(false);
      expect(hasDelete).toBe(false);
    });

    it('includes iam.serviceAccounts.actAs for deploy', () => {
      const builderSection = customRoles.slice(
        customRoles.indexOf('cloud_build_sa:')
      );
      expect(builderSection).toContain('iam.serviceAccounts.actAs');
    });
  });

  describe('deploy.sh — custom role management (Phase 0f)', () => {
    it('references ADR-022 in the custom roles phase', () => {
      expect(deployScript).toContain('ADR-022');
    });

    it('includes Phase 0f for custom role creation', () => {
      expect(deployScript).toContain('Phase 0f');
    });

    it('reads custom roles from iam/custom-roles.yaml', () => {
      expect(deployScript).toContain('custom-roles.yaml');
    });

    it('creates custom roles via gcloud iam roles create', () => {
      expect(deployScript).toContain('gcloud iam roles create');
    });

    it('updates existing custom roles via gcloud iam roles update', () => {
      expect(deployScript).toContain('gcloud iam roles update');
    });

    it('supports SKIP_CUSTOM_ROLES fallback to predefined roles', () => {
      expect(deployScript).toContain('SKIP_CUSTOM_ROLES');
    });

    it('documents SKIP_CUSTOM_ROLES in the script header', () => {
      const headerEnd = deployScript.indexOf('set -euo pipefail');
      const header = deployScript.slice(0, headerEnd);
      expect(header).toContain('SKIP_CUSTOM_ROLES');
    });

    it('custom role phase runs before container build', () => {
      const phase0fIndex = deployScript.indexOf('Phase 0f');
      const phase1Index = deployScript.indexOf('Phase 1:');

      expect(phase0fIndex).toBeGreaterThan(-1);
      expect(phase1Index).toBeGreaterThan(-1);
      expect(phase0fIndex).toBeLessThan(phase1Index);
    });
  });

});
