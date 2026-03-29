/**
 * Action item service layer — business logic for action item CRUD,
 * status tracking, assignee management, and summary grouping.
 *
 * All operations are scoped by userId for tenant isolation (IDOR prevention).
 */

import type { FirestoreAdapter, ListActionsOptions } from '../types/adapters.js';
import type { ActionItem, ActionItemStatus } from '../types/domain.js';

// ── Token generation ────────────────────────────────────────────────

function generateSearchTokens(title: string): string[] {
  return [...new Set(title.toLowerCase().split(/\s+/).filter(Boolean))];
}

// ── Service interface ───────────────────────────────────────────────

export interface ActionServiceDeps {
  firestore: FirestoreAdapter;
}

export interface CreateActionParams {
  userId: string;
  title: string;
  meetingId?: string;
  assignee?: string;
  dueDate?: Date;
  status?: ActionItemStatus;
}

export interface UpdateActionParams {
  title?: string;
  assignee?: string;
  dueDate?: Date;
  status?: ActionItemStatus;
}

export interface ListActionsParams {
  userId: string;
  status?: ActionItemStatus;
  assignee?: string;
  meetingId?: string;
  dueBefore?: Date;
  dueAfter?: Date;
  cursor?: string;
  limit?: number;
}

export interface ActionSummary {
  byStatus: {
    open: number;
    in_progress: number;
    completed: number;
    cancelled: number;
    overdue: number;
    dueThisWeek: number;
  };
  byAssignee: Record<string, number>;
}

// ── Service factory ─────────────────────────────────────────────────

export function createActionService(deps: ActionServiceDeps) {
  const { firestore } = deps;

  return {
    async create(params: CreateActionParams): Promise<ActionItem> {
      const now = new Date();

      const action: ActionItem = {
        id: crypto.randomUUID(),
        userId: params.userId,
        meetingId: params.meetingId,
        title: params.title,
        text: params.title,
        assignee: params.assignee,
        dueDate: params.dueDate,
        status: params.status ?? 'open',
        source: 'manual',
        searchTokens: generateSearchTokens(params.title),
        createdAt: now,
        updatedAt: now,
      };

      await firestore.createAction(action);
      return action;
    },

    async list(params: ListActionsParams): Promise<{
      actions: ActionItem[];
      cursor?: string;
      hasMore: boolean;
    }> {
      const options: ListActionsOptions = {
        userId: params.userId,
        status: params.status,
        assignee: params.assignee,
        meetingId: params.meetingId,
        dueBefore: params.dueBefore,
        dueAfter: params.dueAfter,
        cursor: params.cursor,
        limit: params.limit,
      };

      const result = await firestore.listActions(options);

      return {
        actions: result.actions,
        cursor: result.cursor,
        hasMore: !!result.cursor,
      };
    },

    async getById(actionId: string, userId: string): Promise<ActionItem | null> {
      return firestore.getAction(actionId, userId);
    },

    async update(
      actionId: string,
      userId: string,
      params: UpdateActionParams,
    ): Promise<ActionItem | null> {
      const existing = await firestore.getAction(actionId, userId);
      if (!existing) return null;

      const updates: Partial<ActionItem> = {
        ...params,
        updatedAt: new Date(),
      };

      if (params.title !== undefined) {
        updates.searchTokens = generateSearchTokens(params.title);
      }

      await firestore.updateAction(actionId, userId, updates);

      return {
        ...existing,
        ...updates,
      } as ActionItem;
    },

    async delete(actionId: string, userId: string): Promise<boolean> {
      const existing = await firestore.getAction(actionId, userId);
      if (!existing) return false;

      await firestore.deleteAction(actionId, userId);
      return true;
    },

    async listByMeeting(
      meetingId: string,
      userId: string,
      cursor?: string,
      limit?: number,
    ): Promise<{ actions: ActionItem[]; cursor?: string; hasMore: boolean }> {
      const result = await firestore.listActions({
        userId,
        meetingId,
        cursor,
        limit,
      });

      return {
        actions: result.actions,
        cursor: result.cursor,
        hasMore: !!result.cursor,
      };
    },

    async getSummary(userId: string): Promise<ActionSummary> {
      // Fetch all open/in-progress actions for summary computation
      const allResult = await firestore.listActions({ userId, limit: 10_000 });
      const actions = allResult.actions;

      const now = new Date();
      const startOfWeek = new Date(now);
      startOfWeek.setHours(0, 0, 0, 0);
      // Roll back to Monday
      const day = startOfWeek.getDay();
      const diff = day === 0 ? 6 : day - 1;
      startOfWeek.setDate(startOfWeek.getDate() - diff);

      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(endOfWeek.getDate() + 7);

      const summary: ActionSummary = {
        byStatus: {
          open: 0,
          in_progress: 0,
          completed: 0,
          cancelled: 0,
          overdue: 0,
          dueThisWeek: 0,
        },
        byAssignee: {},
      };

      for (const action of actions) {
        // Count by status
        summary.byStatus[action.status]++;

        // Count overdue: open or in_progress with dueDate in the past
        if (
          action.dueDate &&
          action.dueDate < now &&
          (action.status === 'open' || action.status === 'in_progress')
        ) {
          summary.byStatus.overdue++;
        }

        // Count due this week
        if (
          action.dueDate &&
          action.dueDate >= startOfWeek &&
          action.dueDate < endOfWeek &&
          (action.status === 'open' || action.status === 'in_progress')
        ) {
          summary.byStatus.dueThisWeek++;
        }

        // Count by assignee (only open/in_progress)
        if (
          action.assignee &&
          (action.status === 'open' || action.status === 'in_progress')
        ) {
          summary.byAssignee[action.assignee] =
            (summary.byAssignee[action.assignee] ?? 0) + 1;
        }
      }

      return summary;
    },
  };
}

export type ActionService = ReturnType<typeof createActionService>;
