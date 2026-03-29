/**
 * Template service unit tests — T-028.
 *
 * Tests template CRUD service layer with mocked Firestore adapter.
 * Verifies system template immutability (403 on PUT/DELETE),
 * custom template userId scoping, and system template seeding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTemplateService, type TemplateService } from '../../src/services/template.js';
import type { FirestoreAdapter } from '../../src/types/adapters.js';
import type { Template } from '../../src/types/domain.js';

// ── Mock factory ────────────────────────────────────────────────────

function mockFirestore(): Pick<
  FirestoreAdapter,
  'getTemplate' | 'createTemplate' | 'updateTemplate' | 'deleteTemplate' | 'listTemplates'
> {
  return {
    getTemplate: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
    listTemplates: vi.fn(),
  };
}

function makeTemplate(overrides: Partial<Template> = {}): Template {
  return {
    id: 'tpl-1',
    name: 'Custom Template',
    isSystem: false,
    userId: 'user-1',
    sections: [{ heading: 'Summary', prompt: 'Summarize the meeting.' }],
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeSystemTemplate(overrides: Partial<Template> = {}): Template {
  return makeTemplate({
    id: 'sys-general',
    name: 'General',
    isSystem: true,
    userId: undefined,
    ...overrides,
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('TemplateService', () => {
  let firestore: ReturnType<typeof mockFirestore>;
  let service: TemplateService;

  beforeEach(() => {
    firestore = mockFirestore();
    service = createTemplateService({ firestore: firestore as unknown as FirestoreAdapter });
  });

  describe('list', () => {
    it('delegates to firestore.listTemplates with userId', async () => {
      const templates = [makeSystemTemplate(), makeTemplate()];
      vi.mocked(firestore.listTemplates).mockResolvedValue(templates);

      const result = await service.list('user-1');

      expect(firestore.listTemplates).toHaveBeenCalledWith('user-1');
      expect(result).toEqual(templates);
    });
  });

  describe('getById', () => {
    it('returns template by ID', async () => {
      const template = makeTemplate();
      vi.mocked(firestore.getTemplate).mockResolvedValue(template);

      const result = await service.getById('tpl-1');

      expect(result).toEqual(template);
      expect(firestore.getTemplate).toHaveBeenCalledWith('tpl-1');
    });

    it('returns null when not found', async () => {
      vi.mocked(firestore.getTemplate).mockResolvedValue(null);

      const result = await service.getById('nonexistent');

      expect(result).toBeNull();
    });

    it('returns system templates (accessible to all users)', async () => {
      const systemTpl = makeSystemTemplate();
      vi.mocked(firestore.getTemplate).mockResolvedValue(systemTpl);

      const result = await service.getById('sys-general');

      expect(result).not.toBeNull();
      expect(result!.isSystem).toBe(true);
    });
  });

  describe('create', () => {
    it('creates a custom template with isSystem=false', async () => {
      vi.mocked(firestore.createTemplate).mockResolvedValue(undefined);

      const result = await service.create({
        userId: 'user-1',
        name: 'My Template',
        sections: [{ heading: 'Notes', prompt: 'Take notes.' }],
      });

      expect(result.isSystem).toBe(false);
      expect(result.userId).toBe('user-1');
      expect(result.name).toBe('My Template');
      expect(result.id).toBeDefined();
      expect(firestore.createTemplate).toHaveBeenCalledWith(result);
    });

    it('always forces isSystem to false (cannot be set via API)', async () => {
      vi.mocked(firestore.createTemplate).mockResolvedValue(undefined);

      const result = await service.create({
        userId: 'user-1',
        name: 'Sneaky',
        sections: [{ heading: 'X', prompt: 'Y' }],
      });

      // The create interface doesn't even accept isSystem
      expect(result.isSystem).toBe(false);
    });
  });

  describe('update', () => {
    it('updates a custom template owned by user', async () => {
      vi.mocked(firestore.getTemplate).mockResolvedValue(makeTemplate());
      vi.mocked(firestore.updateTemplate).mockResolvedValue(undefined);

      const result = await service.update('tpl-1', 'user-1', { name: 'Updated Name' });

      expect(result).not.toBe('system');
      expect(result).not.toBe('not_found');
      expect((result as Template).name).toBe('Updated Name');
    });

    it('returns "system" when trying to update a system template', async () => {
      vi.mocked(firestore.getTemplate).mockResolvedValue(makeSystemTemplate());

      const result = await service.update('sys-general', 'user-1', { name: 'Hacked' });

      expect(result).toBe('system');
      expect(firestore.updateTemplate).not.toHaveBeenCalled();
    });

    it('returns "not_found" when template does not exist', async () => {
      vi.mocked(firestore.getTemplate).mockResolvedValue(null);

      const result = await service.update('nonexistent', 'user-1', { name: 'X' });

      expect(result).toBe('not_found');
    });

    it('returns "not_found" when custom template owned by different user', async () => {
      vi.mocked(firestore.getTemplate).mockResolvedValue(makeTemplate({ userId: 'other-user' }));

      const result = await service.update('tpl-1', 'user-1', { name: 'X' });

      expect(result).toBe('not_found');
      expect(firestore.updateTemplate).not.toHaveBeenCalled();
    });

    it('can update sections', async () => {
      vi.mocked(firestore.getTemplate).mockResolvedValue(makeTemplate());
      vi.mocked(firestore.updateTemplate).mockResolvedValue(undefined);

      const newSections = [{ heading: 'New', prompt: 'New prompt' }];
      const result = await service.update('tpl-1', 'user-1', { sections: newSections });

      expect((result as Template).sections).toEqual(newSections);
    });
  });

  describe('delete', () => {
    it('deletes custom template and returns "ok"', async () => {
      vi.mocked(firestore.getTemplate).mockResolvedValue(makeTemplate());
      vi.mocked(firestore.deleteTemplate).mockResolvedValue(undefined);

      const result = await service.delete('tpl-1', 'user-1');

      expect(result).toBe('ok');
      expect(firestore.deleteTemplate).toHaveBeenCalledWith('tpl-1', 'user-1');
    });

    it('returns "system" when trying to delete system template', async () => {
      vi.mocked(firestore.getTemplate).mockResolvedValue(makeSystemTemplate());

      const result = await service.delete('sys-general', 'user-1');

      expect(result).toBe('system');
      expect(firestore.deleteTemplate).not.toHaveBeenCalled();
    });

    it('returns "not_found" when template does not exist', async () => {
      vi.mocked(firestore.getTemplate).mockResolvedValue(null);

      const result = await service.delete('nonexistent', 'user-1');

      expect(result).toBe('not_found');
    });

    it('returns "not_found" when custom template owned by different user', async () => {
      vi.mocked(firestore.getTemplate).mockResolvedValue(makeTemplate({ userId: 'other-user' }));

      const result = await service.delete('tpl-1', 'user-1');

      expect(result).toBe('not_found');
      expect(firestore.deleteTemplate).not.toHaveBeenCalled();
    });
  });

  describe('seedSystemTemplates', () => {
    it('seeds 7 system templates when none exist', async () => {
      vi.mocked(firestore.listTemplates).mockResolvedValue([]);
      vi.mocked(firestore.createTemplate).mockResolvedValue(undefined);

      await service.seedSystemTemplates();

      expect(firestore.createTemplate).toHaveBeenCalledTimes(7);
      // Verify all created templates have isSystem=true
      for (const call of vi.mocked(firestore.createTemplate).mock.calls) {
        expect(call[0].isSystem).toBe(true);
      }
    });

    it('is idempotent — does not duplicate when all 7 exist', async () => {
      const systemTemplates = [
        'General', '1:1', 'Sales', 'Standup', 'Retro', 'Interview', 'Board',
      ].map((name) => makeSystemTemplate({ name, id: `sys-${name.toLowerCase()}` }));

      vi.mocked(firestore.listTemplates).mockResolvedValue(systemTemplates);

      await service.seedSystemTemplates();

      expect(firestore.createTemplate).not.toHaveBeenCalled();
    });

    it('seeds only missing templates when some exist', async () => {
      const existing = [
        makeSystemTemplate({ name: 'General', id: 'sys-1' }),
        makeSystemTemplate({ name: '1:1', id: 'sys-2' }),
      ];

      vi.mocked(firestore.listTemplates).mockResolvedValue(existing);
      vi.mocked(firestore.createTemplate).mockResolvedValue(undefined);

      await service.seedSystemTemplates();

      // Should seed the remaining 5
      expect(firestore.createTemplate).toHaveBeenCalledTimes(5);
    });
  });
});
