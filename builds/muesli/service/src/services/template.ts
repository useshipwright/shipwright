/**
 * Template service layer — business logic for meeting template CRUD
 * and system template seeding.
 *
 * System templates are read-only (403 on mutation).
 * Custom templates are scoped by userId for tenant isolation.
 */

import crypto from 'node:crypto';
import type { FirestoreAdapter } from '../types/adapters.js';
import type { Template, TemplateSection } from '../types/domain.js';

// ── Service interface ───────────────────────────────────────────────

export interface TemplateServiceDeps {
  firestore: FirestoreAdapter;
}

export interface CreateTemplateParams {
  userId: string;
  name: string;
  sections: TemplateSection[];
}

export interface UpdateTemplateParams {
  name?: string;
  sections?: TemplateSection[];
}

// ── System template definitions ─────────────────────────────────────

const SYSTEM_TEMPLATES: Omit<Template, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'General',
    isSystem: true,
    sections: [
      { heading: 'Summary', prompt: 'Provide a concise summary of the meeting in 2-3 paragraphs.' },
      { heading: 'Key Discussion Points', prompt: 'List the main topics discussed with brief descriptions.' },
      { heading: 'Decisions Made', prompt: 'List all decisions that were made during the meeting.' },
      { heading: 'Action Items', prompt: 'Extract all action items with assignees and due dates if mentioned.' },
      { heading: 'Follow-up Topics', prompt: 'List any topics that need follow-up or further discussion.' },
    ],
  },
  {
    name: '1:1',
    isSystem: true,
    sections: [
      { heading: 'Check-in', prompt: 'Summarize how the participants are feeling and any personal updates shared.' },
      { heading: 'Progress Updates', prompt: 'List progress on previously discussed items and ongoing work.' },
      { heading: 'Blockers & Challenges', prompt: 'Identify any blockers, challenges, or concerns raised.' },
      { heading: 'Feedback', prompt: 'Capture any feedback given in either direction.' },
      { heading: 'Action Items', prompt: 'Extract all action items with owners.' },
      { heading: 'Goals for Next Period', prompt: 'List goals or priorities discussed for the upcoming period.' },
    ],
  },
  {
    name: 'Sales',
    isSystem: true,
    sections: [
      { heading: 'Prospect Overview', prompt: 'Summarize the prospect/client context and their needs.' },
      { heading: 'Pain Points', prompt: 'List the pain points and challenges the prospect described.' },
      { heading: 'Solution Discussion', prompt: 'Summarize how the product/solution was positioned.' },
      { heading: 'Objections & Concerns', prompt: 'List any objections or concerns raised by the prospect.' },
      { heading: 'Next Steps', prompt: 'Extract agreed next steps, timeline, and follow-up actions.' },
      { heading: 'Deal Intelligence', prompt: 'Note budget mentions, decision-maker involvement, and competitive mentions.' },
    ],
  },
  {
    name: 'Standup',
    isSystem: true,
    sections: [
      { heading: 'Yesterday / Completed', prompt: 'List what each participant completed since the last standup.' },
      { heading: 'Today / In Progress', prompt: 'List what each participant plans to work on today.' },
      { heading: 'Blockers', prompt: 'List any blockers or impediments mentioned by participants.' },
    ],
  },
  {
    name: 'Retro',
    isSystem: true,
    sections: [
      { heading: 'What Went Well', prompt: 'List positive outcomes and successes discussed.' },
      { heading: 'What Could Be Improved', prompt: 'List areas for improvement and pain points identified.' },
      { heading: 'Action Items', prompt: 'Extract concrete improvement actions with owners and timelines.' },
    ],
  },
  {
    name: 'Interview',
    isSystem: true,
    sections: [
      { heading: 'Candidate Overview', prompt: 'Summarize the candidate background and key qualifications discussed.' },
      { heading: 'Technical Assessment', prompt: 'Summarize technical questions asked and quality of responses.' },
      { heading: 'Behavioral Assessment', prompt: 'Summarize behavioral questions and the candidate responses.' },
      { heading: 'Culture Fit', prompt: 'Note observations about culture fit and team dynamics.' },
      { heading: 'Strengths', prompt: 'List the candidate key strengths observed.' },
      { heading: 'Concerns', prompt: 'List any concerns or areas needing further evaluation.' },
      { heading: 'Recommendation', prompt: 'Summarize the overall recommendation and suggested next steps.' },
    ],
  },
  {
    name: 'Board',
    isSystem: true,
    sections: [
      { heading: 'Executive Summary', prompt: 'Provide a high-level summary of the board meeting.' },
      { heading: 'Financial Review', prompt: 'Summarize financial metrics, performance, and projections discussed.' },
      { heading: 'Strategic Updates', prompt: 'List strategic initiatives and updates presented.' },
      { heading: 'Risks & Challenges', prompt: 'Identify risks, challenges, and mitigation strategies discussed.' },
      { heading: 'Decisions & Resolutions', prompt: 'List all formal decisions and resolutions made by the board.' },
      { heading: 'Action Items', prompt: 'Extract action items with responsible parties and deadlines.' },
    ],
  },
];

// ── Service factory ─────────────────────────────────────────────────

export function createTemplateService(deps: TemplateServiceDeps) {
  const { firestore } = deps;

  return {
    /**
     * List all templates visible to a user: system templates + their custom templates.
     */
    async list(userId: string): Promise<Template[]> {
      return firestore.listTemplates(userId);
    },

    /**
     * Get a template by ID. System templates are accessible to all users.
     * Custom templates are verified at the route level (getTemplate has no userId scope).
     */
    async getById(templateId: string): Promise<Template | null> {
      return firestore.getTemplate(templateId);
    },

    /**
     * Create a custom template scoped to a user.
     * The isSystem flag is always set to false — it cannot be set via the API.
     */
    async create(params: CreateTemplateParams): Promise<Template> {
      const now = new Date();
      const template: Template = {
        id: crypto.randomUUID(),
        name: params.name,
        isSystem: false,
        userId: params.userId,
        sections: params.sections,
        createdAt: now,
        updatedAt: now,
      };

      await firestore.createTemplate(template);
      return template;
    },

    /**
     * Update a custom template. Returns 'system' if the template is a system template.
     * Returns 'not_found' if the template doesn't exist or isn't owned by the user.
     */
    async update(
      templateId: string,
      userId: string,
      params: UpdateTemplateParams,
    ): Promise<Template | 'system' | 'not_found'> {
      const existing = await firestore.getTemplate(templateId);
      if (!existing) return 'not_found';
      if (existing.isSystem) return 'system';
      if (existing.userId !== userId) return 'not_found';

      const updates: Partial<Template> = {
        updatedAt: new Date(),
      };
      if (params.name !== undefined) updates.name = params.name;
      if (params.sections !== undefined) updates.sections = params.sections;

      await firestore.updateTemplate(templateId, userId, updates);

      return { ...existing, ...updates };
    },

    /**
     * Delete a custom template. Returns 'system' if the template is a system template.
     * Returns 'not_found' if the template doesn't exist or isn't owned by the user.
     */
    async delete(
      templateId: string,
      userId: string,
    ): Promise<'ok' | 'system' | 'not_found'> {
      const existing = await firestore.getTemplate(templateId);
      if (!existing) return 'not_found';
      if (existing.isSystem) return 'system';
      if (existing.userId !== userId) return 'not_found';

      await firestore.deleteTemplate(templateId, userId);
      return 'ok';
    },

    /**
     * Seed the 7 built-in system templates on first run.
     * Idempotent — checks if system templates already exist.
     */
    async seedSystemTemplates(): Promise<void> {
      // Check if system templates already exist by listing templates with no userId
      const existing = await firestore.listTemplates('__system__');

      // If we already have system templates, skip seeding
      // listTemplates returns system + user templates; filter to system only
      const systemCount = existing.filter((t) => t.isSystem).length;
      if (systemCount >= SYSTEM_TEMPLATES.length) return;

      const now = new Date();
      for (const def of SYSTEM_TEMPLATES) {
        // Check if this specific template already exists
        const alreadyExists = existing.some(
          (t) => t.isSystem && t.name === def.name,
        );
        if (alreadyExists) continue;

        const template: Template = {
          id: crypto.randomUUID(),
          ...def,
          createdAt: now,
          updatedAt: now,
        };
        await firestore.createTemplate(template);
      }
    },
  };
}

export type TemplateService = ReturnType<typeof createTemplateService>;
