/**
 * Action service unit tests — T-030.
 *
 * Tests action item CRUD, summary endpoint grouping (open, overdue, due this
 * week, by assignee), filtering by status/assignee/meeting/due date, and
 * status transitions.
 *
 * Strategy: Mock FirestoreAdapter at the adapter boundary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createActionService } from '../../src/services/action.js';
import type { FirestoreAdapter } from '../../src/types/adapters.js';
import type { ActionItem } from '../../src/types/domain.js';

// ── Mock factory ─────────────────────────────────────────────────────

function mockFirestore(): FirestoreAdapter {
  return {
    getMeeting: vi.fn(),
    createMeeting: vi.fn(),
    updateMeeting: vi.fn(),
    deleteMeeting: vi.fn(),
    listMeetings: vi.fn(),
    getSegments: vi.fn(),
    batchWriteSegments: vi.fn(),
    getSpeakers: vi.fn(),
    updateSpeaker: vi.fn(),
    getNotes: vi.fn(),
    getNote: vi.fn(),
    getLatestNote: vi.fn(),
    createNote: vi.fn(),
    updateNote: vi.fn(),
    getTemplate: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
    listTemplates: vi.fn(),
    getAction: vi.fn(),
    createAction: vi.fn(),
    updateAction: vi.fn(),
    deleteAction: vi.fn(),
    listActions: vi.fn(),
    getShare: vi.fn(),
    createShare: vi.fn(),
    deleteShare: vi.fn(),
    listSharesByMeeting: vi.fn(),
    incrementShareViewCount: vi.fn(),
    storeEmbeddings: vi.fn(),
    deleteEmbeddingsByMeeting: vi.fn(),
    vectorSearch: vi.fn(),
    searchMeetings: vi.fn(),
    searchActions: vi.fn(),
    getUser: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    deleteUser: vi.fn(),
    healthCheck: vi.fn(),
    deleteAllUserData: vi.fn(),
    listConnectedCalendarUsers: vi.fn(),
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────

const USER_ID = 'user-123';
const now = new Date('2026-03-15T10:00:00Z');

function makeAction(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: 'action-1',
    userId: USER_ID,
    title: 'Review PR',
    text: 'Review PR',
    status: 'open',
    source: 'manual',
    searchTokens: ['review', 'pr'],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ActionService', () => {
  let firestore: ReturnType<typeof mockFirestore>;
  let service: ReturnType<typeof createActionService>;

  beforeEach(() => {
    vi.clearAllMocks();
    firestore = mockFirestore();
    service = createActionService({ firestore });
  });

  describe('create()', () => {
    it('should create an action item with default open status', async () => {
      (firestore.createAction as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const action = await service.create({
        userId: USER_ID,
        title: 'Review the documentation',
        meetingId: 'meeting-1',
        assignee: 'Alice',
      });

      expect(action.userId).toBe(USER_ID);
      expect(action.title).toBe('Review the documentation');
      expect(action.status).toBe('open');
      expect(action.source).toBe('manual');
      expect(action.meetingId).toBe('meeting-1');
      expect(action.assignee).toBe('Alice');
      expect(action.id).toBeDefined();
      expect(firestore.createAction).toHaveBeenCalledWith(expect.objectContaining({ title: 'Review the documentation' }));
    });

    it('should generate search tokens from title', async () => {
      (firestore.createAction as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const action = await service.create({
        userId: USER_ID,
        title: 'Fix login bug',
      });

      expect(action.searchTokens).toContain('fix');
      expect(action.searchTokens).toContain('login');
      expect(action.searchTokens).toContain('bug');
    });
  });

  describe('list()', () => {
    it('should return actions with cursor-based pagination', async () => {
      const actions = [makeAction({ id: 'a1' }), makeAction({ id: 'a2' })];
      (firestore.listActions as ReturnType<typeof vi.fn>).mockResolvedValue({
        actions,
        cursor: 'next-cursor',
      });

      const result = await service.list({ userId: USER_ID, limit: 10 });

      expect(result.actions).toHaveLength(2);
      expect(result.cursor).toBe('next-cursor');
      expect(result.hasMore).toBe(true);
    });

    it('should pass filter parameters to firestore', async () => {
      (firestore.listActions as ReturnType<typeof vi.fn>).mockResolvedValue({
        actions: [],
      });

      await service.list({
        userId: USER_ID,
        status: 'open',
        assignee: 'Alice',
        meetingId: 'meeting-1',
      });

      expect(firestore.listActions).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          status: 'open',
          assignee: 'Alice',
          meetingId: 'meeting-1',
        }),
      );
    });

    it('should filter by due date range', async () => {
      const dueBefore = new Date('2026-03-20');
      const dueAfter = new Date('2026-03-10');
      (firestore.listActions as ReturnType<typeof vi.fn>).mockResolvedValue({
        actions: [],
      });

      await service.list({ userId: USER_ID, dueBefore, dueAfter });

      expect(firestore.listActions).toHaveBeenCalledWith(
        expect.objectContaining({ dueBefore, dueAfter }),
      );
    });

    it('should return hasMore=false when no cursor', async () => {
      (firestore.listActions as ReturnType<typeof vi.fn>).mockResolvedValue({
        actions: [makeAction()],
      });

      const result = await service.list({ userId: USER_ID });

      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeUndefined();
    });
  });

  describe('getById()', () => {
    it('should return action scoped to userId', async () => {
      const action = makeAction();
      (firestore.getAction as ReturnType<typeof vi.fn>).mockResolvedValue(action);

      const result = await service.getById('action-1', USER_ID);

      expect(result).toEqual(action);
      expect(firestore.getAction).toHaveBeenCalledWith('action-1', USER_ID);
    });

    it('should return null for nonexistent action', async () => {
      (firestore.getAction as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.getById('nonexistent', USER_ID);

      expect(result).toBeNull();
    });
  });

  describe('update()', () => {
    it('should update action item fields', async () => {
      const existing = makeAction();
      (firestore.getAction as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
      (firestore.updateAction as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const result = await service.update('action-1', USER_ID, {
        title: 'Updated title',
        status: 'in_progress',
      });

      expect(result).not.toBeNull();
      expect(result!.title).toBe('Updated title');
      expect(result!.status).toBe('in_progress');
    });

    it('should regenerate search tokens when title changes', async () => {
      const existing = makeAction();
      (firestore.getAction as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
      (firestore.updateAction as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await service.update('action-1', USER_ID, { title: 'Deploy service' });

      expect(firestore.updateAction).toHaveBeenCalledWith(
        'action-1',
        USER_ID,
        expect.objectContaining({
          searchTokens: expect.arrayContaining(['deploy', 'service']),
        }),
      );
    });

    it('should return null when action not found', async () => {
      (firestore.getAction as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.update('nonexistent', USER_ID, { status: 'completed' });

      expect(result).toBeNull();
    });
  });

  describe('delete()', () => {
    it('should delete existing action', async () => {
      (firestore.getAction as ReturnType<typeof vi.fn>).mockResolvedValue(makeAction());
      (firestore.deleteAction as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const result = await service.delete('action-1', USER_ID);

      expect(result).toBe(true);
      expect(firestore.deleteAction).toHaveBeenCalledWith('action-1', USER_ID);
    });

    it('should return false when action not found', async () => {
      (firestore.getAction as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.delete('nonexistent', USER_ID);

      expect(result).toBe(false);
    });
  });

  describe('status transitions', () => {
    it.each([
      ['open', 'in_progress'],
      ['in_progress', 'completed'],
      ['open', 'cancelled'],
      ['in_progress', 'cancelled'],
    ] as const)('should transition from %s to %s', async (from, to) => {
      const action = makeAction({ status: from });
      (firestore.getAction as ReturnType<typeof vi.fn>).mockResolvedValue(action);
      (firestore.updateAction as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const result = await service.update('action-1', USER_ID, { status: to });

      expect(result!.status).toBe(to);
    });
  });

  describe('getSummary()', () => {
    it('should group actions by status including overdue and due this week', async () => {
      // Use a fixed "now" within the same week to ensure dueThisWeek calculation works
      const monday = new Date('2026-03-16T10:00:00Z'); // Monday
      vi.setSystemTime(monday);

      const actions: ActionItem[] = [
        makeAction({ id: 'a1', status: 'open', assignee: 'Alice' }),
        makeAction({ id: 'a2', status: 'open', assignee: 'Alice', dueDate: new Date('2026-03-10') }), // overdue
        makeAction({ id: 'a3', status: 'in_progress', assignee: 'Bob', dueDate: new Date('2026-03-18') }), // due this week
        makeAction({ id: 'a4', status: 'completed' }),
        makeAction({ id: 'a5', status: 'cancelled' }),
      ];

      (firestore.listActions as ReturnType<typeof vi.fn>).mockResolvedValue({ actions });

      const summary = await service.getSummary(USER_ID);

      expect(summary.byStatus.open).toBe(2);
      expect(summary.byStatus.in_progress).toBe(1);
      expect(summary.byStatus.completed).toBe(1);
      expect(summary.byStatus.cancelled).toBe(1);
      expect(summary.byStatus.overdue).toBe(1); // a2 is overdue
      expect(summary.byStatus.dueThisWeek).toBe(1); // a3 is due this week

      expect(summary.byAssignee['Alice']).toBe(2);
      expect(summary.byAssignee['Bob']).toBe(1);

      vi.useRealTimers();
    });

    it('should only count open/in_progress for byAssignee', async () => {
      const actions: ActionItem[] = [
        makeAction({ id: 'a1', status: 'completed', assignee: 'Alice' }),
        makeAction({ id: 'a2', status: 'open', assignee: 'Bob' }),
      ];

      (firestore.listActions as ReturnType<typeof vi.fn>).mockResolvedValue({ actions });

      const summary = await service.getSummary(USER_ID);

      expect(summary.byAssignee['Alice']).toBeUndefined();
      expect(summary.byAssignee['Bob']).toBe(1);
    });

    it('should handle empty action list', async () => {
      (firestore.listActions as ReturnType<typeof vi.fn>).mockResolvedValue({ actions: [] });

      const summary = await service.getSummary(USER_ID);

      expect(summary.byStatus.open).toBe(0);
      expect(summary.byStatus.overdue).toBe(0);
      expect(summary.byStatus.dueThisWeek).toBe(0);
      expect(Object.keys(summary.byAssignee)).toHaveLength(0);
    });
  });

  describe('listByMeeting()', () => {
    it('should list actions scoped to a specific meeting', async () => {
      const actions = [makeAction({ meetingId: 'meeting-1' })];
      (firestore.listActions as ReturnType<typeof vi.fn>).mockResolvedValue({ actions });

      const result = await service.listByMeeting('meeting-1', USER_ID);

      expect(firestore.listActions).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          meetingId: 'meeting-1',
        }),
      );
      expect(result.actions).toHaveLength(1);
    });
  });
});
