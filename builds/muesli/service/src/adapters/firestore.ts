/**
 * Firestore adapter implementation (ADR-005).
 *
 * Thin wrapper around Firebase Admin Firestore SDK.
 * All queries MUST include userId scope for tenant isolation (IDOR prevention).
 * Provides typed collection accessors, batch writes, and vector nearest-neighbor queries.
 *
 * Subcollection layout (ADR-004):
 *   /meetings/{meetingId}/segments/{segmentId}
 *   /meetings/{meetingId}/notes/{version}
 *   /meetings/{meetingId}/speakers/{speakerId}
 */

import {
  initializeApp,
  cert,
  getApps,
  type App,
  type ServiceAccount,
} from 'firebase-admin/app';
import {
  getFirestore,
  FieldValue,
  type Firestore,
  type DocumentData,
  type Query,
} from 'firebase-admin/firestore';

import type { FirestoreAdapter } from '../types/adapters.js';

// Re-export types so consumers can import from this module
export type { FirestoreAdapter, VectorSearchOptions, VectorSearchResult } from '../types/adapters.js';
import type {
  Meeting,
  TranscriptSegment,
  MeetingNote,
  Template,
  ActionItem,
  Share,
  User,
  EmbeddingChunk,
  Speaker,
} from '../types/domain.js';

// ── Constants ────────────────────────────────────────────────────────

const BATCH_LIMIT = 500; // Firestore max batch size

// ── Collection paths ─────────────────────────────────────────────────

const Collections = {
  users: 'users',
  meetings: 'meetings',
  templates: 'templates',
  actions: 'actions',
  shares: 'shares',
  embeddings: 'embeddings',
  // Subcollections under meetings:
  segments: (meetingId: string) => `meetings/${meetingId}/segments`,
  notes: (meetingId: string) => `meetings/${meetingId}/notes`,
  speakers: (meetingId: string) => `meetings/${meetingId}/speakers`,
} as const;

// ── Firestore ↔ Domain converters ────────────────────────────────────

function toDate(val: unknown): Date {
  if (val instanceof Date) return val;
  if (val && typeof val === 'object' && 'toDate' in val && typeof (val as { toDate: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate();
  }
  return new Date(val as string | number);
}

function meetingFromDoc(doc: DocumentData): Meeting {
  const d = doc as Record<string, unknown>;
  return {
    id: d.id as string,
    userId: d.userId as string,
    title: d.title as string,
    status: d.status as Meeting['status'],
    error: d.error as string | undefined,
    startedAt: d.startedAt ? toDate(d.startedAt) : undefined,
    endedAt: d.endedAt ? toDate(d.endedAt) : undefined,
    durationSeconds: d.durationSeconds as number | undefined,
    attendees: (d.attendees ?? []) as Meeting['attendees'],
    tags: (d.tags ?? []) as string[],
    isStarred: (d.isStarred ?? false) as boolean,
    calendarEventId: d.calendarEventId as string | undefined,
    audioPath: d.audioPath as string | undefined,
    latestNoteVersion: (d.latestNoteVersion ?? 0) as number,
    speakerStats: d.speakerStats as Meeting['speakerStats'],
    searchTokens: (d.searchTokens ?? []) as string[],
    createdAt: toDate(d.createdAt),
    updatedAt: toDate(d.updatedAt),
  };
}

function segmentFromDoc(doc: DocumentData): TranscriptSegment {
  const d = doc as Record<string, unknown>;
  return {
    id: d.id as string,
    speaker: d.speaker as string,
    speakerId: d.speakerId as string,
    text: d.text as string,
    startTime: d.startTime as number,
    endTime: d.endTime as number,
    confidence: d.confidence as number | undefined,
    channel: d.channel as TranscriptSegment['channel'],
    isUserNote: (d.isUserNote ?? false) as boolean,
    searchTokens: (d.searchTokens ?? []) as string[],
  };
}

function speakerFromDoc(doc: DocumentData): Speaker {
  const d = doc as Record<string, unknown>;
  return {
    id: d.id as string,
    label: d.label as string,
    resolvedName: d.resolvedName as string | undefined,
    resolvedEmail: d.resolvedEmail as string | undefined,
  };
}

function noteFromDoc(doc: DocumentData): MeetingNote {
  const d = doc as Record<string, unknown>;
  return {
    version: d.version as number,
    templateId: d.templateId as string,
    sections: (d.sections ?? []) as MeetingNote['sections'],
    isEdited: (d.isEdited ?? false) as boolean,
    model: d.model as string,
    inputTokens: d.inputTokens as number,
    outputTokens: d.outputTokens as number,
    generationLatencyMs: d.generationLatencyMs as number,
    generatedAt: toDate(d.generatedAt),
  };
}

function templateFromDoc(doc: DocumentData): Template {
  const d = doc as Record<string, unknown>;
  return {
    id: d.id as string,
    name: d.name as string,
    isSystem: (d.isSystem ?? false) as boolean,
    userId: d.userId as string | undefined,
    sections: (d.sections ?? []) as Template['sections'],
    createdAt: toDate(d.createdAt),
    updatedAt: toDate(d.updatedAt),
  };
}

function actionFromDoc(doc: DocumentData): ActionItem {
  const d = doc as Record<string, unknown>;
  return {
    id: d.id as string,
    userId: d.userId as string,
    meetingId: d.meetingId as string | undefined,
    title: d.title as string,
    text: d.text as string,
    assignee: d.assignee as string | undefined,
    dueDate: d.dueDate ? toDate(d.dueDate) : undefined,
    status: d.status as ActionItem['status'],
    source: d.source as ActionItem['source'],
    sourceMeetingId: d.sourceMeetingId as string | undefined,
    linkedSegmentId: d.linkedSegmentId as string | undefined,
    searchTokens: (d.searchTokens ?? []) as string[],
    createdAt: toDate(d.createdAt),
    updatedAt: toDate(d.updatedAt),
  };
}

function shareFromDoc(doc: DocumentData): Share {
  const d = doc as Record<string, unknown>;
  return {
    shareId: d.shareId as string,
    meetingId: d.meetingId as string,
    userId: d.userId as string,
    accessMode: d.accessMode as Share['accessMode'],
    allowedEmails: d.allowedEmails as string[] | undefined,
    includeTranscript: (d.includeTranscript ?? false) as boolean,
    includeAudio: (d.includeAudio ?? false) as boolean,
    expiresAt: d.expiresAt ? toDate(d.expiresAt) : undefined,
    viewCount: (d.viewCount ?? 0) as number,
    createdAt: toDate(d.createdAt),
  };
}

function userFromDoc(doc: DocumentData): User {
  const d = doc as Record<string, unknown>;
  return {
    id: d.id as string,
    email: d.email as string,
    displayName: d.displayName as string | undefined,
    defaultTemplateId: d.defaultTemplateId as string | undefined,
    transcriptionBackend: (d.transcriptionBackend ?? 'deepgram') as User['transcriptionBackend'],
    autoTranscribe: (d.autoTranscribe ?? true) as boolean,
    timezone: (d.timezone ?? 'UTC') as string,
    language: (d.language ?? 'en') as string,
    calendarConnected: (d.calendarConnected ?? false) as boolean,
    calendarTokens: d.calendarTokens
      ? {
          accessToken: (d.calendarTokens as Record<string, unknown>).accessToken as string,
          refreshToken: (d.calendarTokens as Record<string, unknown>).refreshToken as string,
          expiry: toDate((d.calendarTokens as Record<string, unknown>).expiry),
        }
      : undefined,
    calendarSyncToken: d.calendarSyncToken as string | undefined,
    createdAt: toDate(d.createdAt),
    updatedAt: toDate(d.updatedAt),
  };
}

function embeddingFromDoc(doc: DocumentData): EmbeddingChunk {
  const d = doc as Record<string, unknown>;
  let embedding: number[] = [];
  if (Array.isArray(d.embedding)) {
    embedding = d.embedding as number[];
  } else if (d.embedding && typeof d.embedding === 'object' && 'toArray' in d.embedding) {
    embedding = (d.embedding as { toArray: () => number[] }).toArray();
  }
  return {
    id: d.id as string,
    meetingId: d.meetingId as string,
    userId: d.userId as string,
    source: d.source as EmbeddingChunk['source'],
    sectionHeading: d.sectionHeading as string | undefined,
    text: d.text as string,
    embedding,
    meetingTitle: d.meetingTitle as string,
    meetingDate: toDate(d.meetingDate),
    speaker: d.speaker as string | undefined,
    createdAt: toDate(d.createdAt),
  };
}

// ── Implementation ───────────────────────────────────────────────────

export function createFirestoreAdapter(serviceAccountJson: string): FirestoreAdapter {
  const db = initFirestore(serviceAccountJson);

  return {
    // ── Users ──────────────────────────────────────────────────────
    async getUser(userId) {
      const snap = await db.collection(Collections.users).doc(userId).get();
      return snap.exists ? userFromDoc(snap.data()!) : null;
    },

    async createUser(user) {
      await db.collection(Collections.users).doc(user.id).set(user);
    },

    async updateUser(userId, data) {
      await db.collection(Collections.users).doc(userId).update(data);
    },

    async deleteUser(userId) {
      await db.collection(Collections.users).doc(userId).delete();
    },

    async listConnectedCalendarUsers() {
      const snap = await db
        .collection(Collections.users)
        .where('calendarConnected', '==', true)
        .get();
      return snap.docs.map((doc) => userFromDoc(doc.data()));
    },

    // ── Meetings ───────────────────────────────────────────────────
    async getMeeting(meetingId, userId) {
      const snap = await db.collection(Collections.meetings).doc(meetingId).get();
      if (!snap.exists) return null;
      const meeting = meetingFromDoc(snap.data()!);
      // IDOR guard: verify ownership
      if (meeting.userId !== userId) return null;
      return meeting;
    },

    async createMeeting(meeting) {
      await db.collection(Collections.meetings).doc(meeting.id).set(meeting);
    },

    async updateMeeting(meetingId, userId, data) {
      const ref = db.collection(Collections.meetings).doc(meetingId);
      const snap = await ref.get();
      if (!snap.exists || (snap.data() as Record<string, unknown>).userId !== userId) {
        throw new Error('Meeting not found or access denied');
      }
      await ref.update(data);
    },

    async deleteMeeting(meetingId, userId) {
      const ref = db.collection(Collections.meetings).doc(meetingId);
      const snap = await ref.get();
      if (!snap.exists || (snap.data() as Record<string, unknown>).userId !== userId) {
        throw new Error('Meeting not found or access denied');
      }
      // Delete subcollections first
      await deleteSubcollection(db, Collections.segments(meetingId));
      await deleteSubcollection(db, Collections.notes(meetingId));
      await deleteSubcollection(db, Collections.speakers(meetingId));
      await ref.delete();
    },

    async listMeetings(options) {
      let q: Query = db
        .collection(Collections.meetings)
        .where('userId', '==', options.userId);

      if (options.status) {
        q = q.where('status', '==', options.status);
      }
      if (options.isStarred !== undefined) {
        q = q.where('isStarred', '==', options.isStarred);
      }
      if (options.tag) {
        q = q.where('tags', 'array-contains', options.tag);
      }

      const sortField = options.sortBy ?? 'createdAt';
      const sortOrder = options.sortOrder ?? 'desc';
      q = q.orderBy(sortField, sortOrder);

      if (options.cursor) {
        const cursorSnap = await db.collection(Collections.meetings).doc(options.cursor).get();
        if (cursorSnap.exists) {
          q = q.startAfter(cursorSnap);
        }
      }

      const limit = options.limit ?? 20;
      q = q.limit(limit + 1);

      const snap = await q.get();
      const docs = snap.docs.map((d) => meetingFromDoc(d.data()));
      const hasMore = docs.length > limit;
      const meetings = hasMore ? docs.slice(0, limit) : docs;
      const cursor = hasMore ? meetings[meetings.length - 1].id : undefined;

      return { meetings, cursor };
    },

    // ── Transcript Segments (subcollection) ────────────────────────
    async getSegments(meetingId, userId) {
      // Verify meeting ownership first
      const meetingSnap = await db.collection(Collections.meetings).doc(meetingId).get();
      if (!meetingSnap.exists || (meetingSnap.data() as Record<string, unknown>).userId !== userId) {
        return [];
      }
      const snap = await db
        .collection(Collections.segments(meetingId))
        .orderBy('startTime', 'asc')
        .get();
      return snap.docs.map((d) => segmentFromDoc(d.data()));
    },

    async batchWriteSegments(meetingId, segments) {
      // Write in chunks of BATCH_LIMIT (Firestore max)
      for (let i = 0; i < segments.length; i += BATCH_LIMIT) {
        const chunk = segments.slice(i, i + BATCH_LIMIT);
        const batch = db.batch();
        for (const seg of chunk) {
          const ref = db.collection(Collections.segments(meetingId)).doc(seg.id);
          batch.set(ref, seg);
        }
        await batch.commit();
      }
    },

    // ── Speakers (subcollection) ───────────────────────────────────
    async getSpeakers(meetingId, userId) {
      const meetingSnap = await db.collection(Collections.meetings).doc(meetingId).get();
      if (!meetingSnap.exists || (meetingSnap.data() as Record<string, unknown>).userId !== userId) {
        return [];
      }
      const snap = await db.collection(Collections.speakers(meetingId)).get();
      return snap.docs.map((d) => speakerFromDoc(d.data()));
    },

    async updateSpeaker(meetingId, speakerId, userId, data) {
      const meetingSnap = await db.collection(Collections.meetings).doc(meetingId).get();
      if (!meetingSnap.exists || (meetingSnap.data() as Record<string, unknown>).userId !== userId) {
        throw new Error('Meeting not found or access denied');
      }
      await db.collection(Collections.speakers(meetingId)).doc(speakerId).set(data, { merge: true });
    },

    // ── Meeting Notes (subcollection) ──────────────────────────────
    async getNotes(meetingId, userId) {
      const meetingSnap = await db.collection(Collections.meetings).doc(meetingId).get();
      if (!meetingSnap.exists || (meetingSnap.data() as Record<string, unknown>).userId !== userId) {
        return [];
      }
      const snap = await db
        .collection(Collections.notes(meetingId))
        .orderBy('version', 'desc')
        .get();
      return snap.docs.map((d) => noteFromDoc(d.data()));
    },

    async getNote(meetingId, version, userId) {
      const meetingSnap = await db.collection(Collections.meetings).doc(meetingId).get();
      if (!meetingSnap.exists || (meetingSnap.data() as Record<string, unknown>).userId !== userId) {
        return null;
      }
      const snap = await db
        .collection(Collections.notes(meetingId))
        .doc(String(version))
        .get();
      return snap.exists ? noteFromDoc(snap.data()!) : null;
    },

    async getLatestNote(meetingId, userId) {
      const meetingSnap = await db.collection(Collections.meetings).doc(meetingId).get();
      if (!meetingSnap.exists || (meetingSnap.data() as Record<string, unknown>).userId !== userId) {
        return null;
      }
      const snap = await db
        .collection(Collections.notes(meetingId))
        .orderBy('version', 'desc')
        .limit(1)
        .get();
      return snap.empty ? null : noteFromDoc(snap.docs[0].data());
    },

    async createNote(meetingId, note) {
      await db
        .collection(Collections.notes(meetingId))
        .doc(String(note.version))
        .set(note);
    },

    async updateNote(meetingId, version, userId, data) {
      const meetingSnap = await db.collection(Collections.meetings).doc(meetingId).get();
      if (!meetingSnap.exists || (meetingSnap.data() as Record<string, unknown>).userId !== userId) {
        throw new Error('Meeting not found or access denied');
      }
      await db
        .collection(Collections.notes(meetingId))
        .doc(String(version))
        .update(data);
    },

    // ── Templates ──────────────────────────────────────────────────
    async getTemplate(templateId) {
      const snap = await db.collection(Collections.templates).doc(templateId).get();
      return snap.exists ? templateFromDoc(snap.data()!) : null;
    },

    async createTemplate(template) {
      await db.collection(Collections.templates).doc(template.id).set(template);
    },

    async updateTemplate(templateId, userId, data) {
      const ref = db.collection(Collections.templates).doc(templateId);
      const snap = await ref.get();
      if (!snap.exists) throw new Error('Template not found');
      const doc = snap.data() as Record<string, unknown>;
      if (doc.isSystem) throw new Error('Cannot modify system template');
      if (doc.userId !== userId) throw new Error('Access denied');
      await ref.update(data);
    },

    async deleteTemplate(templateId, userId) {
      const ref = db.collection(Collections.templates).doc(templateId);
      const snap = await ref.get();
      if (!snap.exists) throw new Error('Template not found');
      const doc = snap.data() as Record<string, unknown>;
      if (doc.isSystem) throw new Error('Cannot delete system template');
      if (doc.userId !== userId) throw new Error('Access denied');
      await ref.delete();
    },

    async listTemplates(userId) {
      // System templates + user's custom templates
      const [systemSnap, userSnap] = await Promise.all([
        db.collection(Collections.templates).where('isSystem', '==', true).get(),
        db.collection(Collections.templates).where('userId', '==', userId).get(),
      ]);
      const templates = [
        ...systemSnap.docs.map((d) => templateFromDoc(d.data())),
        ...userSnap.docs.map((d) => templateFromDoc(d.data())),
      ];
      return templates;
    },

    // ── Action Items ───────────────────────────────────────────────
    async getAction(actionId, userId) {
      const snap = await db.collection(Collections.actions).doc(actionId).get();
      if (!snap.exists) return null;
      const action = actionFromDoc(snap.data()!);
      if (action.userId !== userId) return null;
      return action;
    },

    async createAction(action) {
      await db.collection(Collections.actions).doc(action.id).set(action);
    },

    async updateAction(actionId, userId, data) {
      const ref = db.collection(Collections.actions).doc(actionId);
      const snap = await ref.get();
      if (!snap.exists || (snap.data() as Record<string, unknown>).userId !== userId) {
        throw new Error('Action not found or access denied');
      }
      await ref.update(data);
    },

    async deleteAction(actionId, userId) {
      const ref = db.collection(Collections.actions).doc(actionId);
      const snap = await ref.get();
      if (!snap.exists || (snap.data() as Record<string, unknown>).userId !== userId) {
        throw new Error('Action not found or access denied');
      }
      await ref.delete();
    },

    async listActions(options) {
      let q: Query = db
        .collection(Collections.actions)
        .where('userId', '==', options.userId);

      if (options.status) {
        q = q.where('status', '==', options.status);
      }
      if (options.assignee) {
        q = q.where('assignee', '==', options.assignee);
      }
      if (options.meetingId) {
        q = q.where('meetingId', '==', options.meetingId);
      }
      if (options.dueBefore) {
        q = q.where('dueDate', '<=', options.dueBefore);
      }
      if (options.dueAfter) {
        q = q.where('dueDate', '>=', options.dueAfter);
      }

      q = q.orderBy('createdAt', 'desc');

      if (options.cursor) {
        const cursorSnap = await db.collection(Collections.actions).doc(options.cursor).get();
        if (cursorSnap.exists) {
          q = q.startAfter(cursorSnap);
        }
      }

      const limit = options.limit ?? 20;
      q = q.limit(limit + 1);

      const snap = await q.get();
      const docs = snap.docs.map((d) => actionFromDoc(d.data()));
      const hasMore = docs.length > limit;
      const actions = hasMore ? docs.slice(0, limit) : docs;
      const cursor = hasMore ? actions[actions.length - 1].id : undefined;

      return { actions, cursor };
    },

    // ── Shares ─────────────────────────────────────────────────────
    async getShare(shareId) {
      const snap = await db.collection(Collections.shares).doc(shareId).get();
      return snap.exists ? shareFromDoc(snap.data()!) : null;
    },

    async createShare(share) {
      await db.collection(Collections.shares).doc(share.shareId).set(share);
    },

    async deleteShare(shareId, userId) {
      const ref = db.collection(Collections.shares).doc(shareId);
      const snap = await ref.get();
      if (!snap.exists || (snap.data() as Record<string, unknown>).userId !== userId) {
        throw new Error('Share not found or access denied');
      }
      await ref.delete();
    },

    async listSharesByMeeting(meetingId, userId) {
      const snap = await db
        .collection(Collections.shares)
        .where('meetingId', '==', meetingId)
        .where('userId', '==', userId)
        .get();
      return snap.docs.map((d) => shareFromDoc(d.data()));
    },

    async incrementShareViewCount(shareId) {
      await db.collection(Collections.shares).doc(shareId).update({
        viewCount: FieldValue.increment(1),
      });
    },

    // ── Embeddings & Vector Search ─────────────────────────────────
    async storeEmbeddings(chunks) {
      for (let i = 0; i < chunks.length; i += BATCH_LIMIT) {
        const slice = chunks.slice(i, i + BATCH_LIMIT);
        const batch = db.batch();
        for (const chunk of slice) {
          const ref = db.collection(Collections.embeddings).doc(chunk.id);
          batch.set(ref, {
            ...chunk,
            // Store as Firestore VectorValue for HNSW index
            embedding: FieldValue.vector(chunk.embedding),
          });
        }
        await batch.commit();
      }
    },

    async deleteEmbeddingsByMeeting(meetingId, userId) {
      const snap = await db
        .collection(Collections.embeddings)
        .where('meetingId', '==', meetingId)
        .where('userId', '==', userId)
        .get();

      for (let i = 0; i < snap.docs.length; i += BATCH_LIMIT) {
        const slice = snap.docs.slice(i, i + BATCH_LIMIT);
        const batch = db.batch();
        for (const doc of slice) {
          batch.delete(doc.ref);
        }
        await batch.commit();
      }
    },

    async vectorSearch(options) {
      // SECURITY: userId filter is mandatory (ADR-001, threat model)
      let q: Query = db
        .collection(Collections.embeddings)
        .where('userId', '==', options.userId);

      if (options.filters?.meetingId) {
        q = q.where('meetingId', '==', options.filters.meetingId);
      }
      if (options.filters?.sourceType) {
        q = q.where('source', '==', options.filters.sourceType);
      }
      if (options.filters?.dateFrom) {
        q = q.where('meetingDate', '>=', options.filters.dateFrom);
      }
      if (options.filters?.dateTo) {
        q = q.where('meetingDate', '<=', options.filters.dateTo);
      }

      const vectorQuery = q.findNearest({
        vectorField: 'embedding',
        queryVector: options.queryVector,
        limit: options.limit,
        distanceMeasure: 'COSINE',
        distanceResultField: '__distance',
      });

      const snap = await vectorQuery.get();
      return snap.docs.map((doc) => {
        const data = doc.data() as Record<string, unknown>;
        const distance = (data.__distance as number) ?? 0;
        return {
          chunk: embeddingFromDoc(data),
          // Cosine distance → similarity: 1 - distance
          similarity: 1 - distance,
        };
      });
    },

    // ── Full-text search (tokenized arrays) ────────────────────────
    async searchMeetings(userId, tokens, cursor, limit = 20) {
      if (tokens.length === 0) return { meetings: [], cursor: undefined };

      let q: Query = db
        .collection(Collections.meetings)
        .where('userId', '==', userId)
        .where('searchTokens', 'array-contains-any', tokens.slice(0, 10))
        .orderBy('createdAt', 'desc');

      if (cursor) {
        const cursorSnap = await db.collection(Collections.meetings).doc(cursor).get();
        if (cursorSnap.exists) {
          q = q.startAfter(cursorSnap);
        }
      }

      q = q.limit(limit + 1);
      const snap = await q.get();
      const docs = snap.docs.map((d) => meetingFromDoc(d.data()));
      const hasMore = docs.length > limit;
      const meetings = hasMore ? docs.slice(0, limit) : docs;
      const nextCursor = hasMore ? meetings[meetings.length - 1].id : undefined;

      return { meetings, cursor: nextCursor };
    },

    async searchActions(userId, tokens, cursor, limit = 20) {
      if (tokens.length === 0) return { actions: [], cursor: undefined };

      let q: Query = db
        .collection(Collections.actions)
        .where('userId', '==', userId)
        .where('searchTokens', 'array-contains-any', tokens.slice(0, 10))
        .orderBy('createdAt', 'desc');

      if (cursor) {
        const cursorSnap = await db.collection(Collections.actions).doc(cursor).get();
        if (cursorSnap.exists) {
          q = q.startAfter(cursorSnap);
        }
      }

      q = q.limit(limit + 1);
      const snap = await q.get();
      const docs = snap.docs.map((d) => actionFromDoc(d.data()));
      const hasMore = docs.length > limit;
      const actions = hasMore ? docs.slice(0, limit) : docs;
      const nextCursor = hasMore ? actions[actions.length - 1].id : undefined;

      return { actions, cursor: nextCursor };
    },

    // ── Health ─────────────────────────────────────────────────────
    async healthCheck() {
      try {
        // Attempt a lightweight read to verify connectivity
        await db.collection(Collections.users).limit(1).get();
        return true;
      } catch {
        return false;
      }
    },

    // ── Cascade delete (GDPR) ──────────────────────────────────────
    async deleteAllUserData(userId) {
      // 1. Find and delete all user meetings (with subcollections)
      const meetingsSnap = await db
        .collection(Collections.meetings)
        .where('userId', '==', userId)
        .get();

      for (const meetingDoc of meetingsSnap.docs) {
        const meetingId = meetingDoc.id;
        await deleteSubcollection(db, Collections.segments(meetingId));
        await deleteSubcollection(db, Collections.notes(meetingId));
        await deleteSubcollection(db, Collections.speakers(meetingId));
        await meetingDoc.ref.delete();
      }

      // 2. Delete actions
      await deleteByUserQuery(db, Collections.actions, userId);

      // 3. Delete shares
      await deleteByUserQuery(db, Collections.shares, userId);

      // 4. Delete custom templates
      await deleteByUserQuery(db, Collections.templates, userId);

      // 5. Delete embeddings
      await deleteByUserQuery(db, Collections.embeddings, userId);

      // 6. Delete user profile
      await db.collection(Collections.users).doc(userId).delete();
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function initFirestore(serviceAccountJson: string): Firestore {
  let app: App;
  const existing = getApps();
  if (existing.length > 0) {
    app = existing[0];
  } else if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson) as ServiceAccount;
    app = initializeApp({ credential: cert(serviceAccount) });
  } else {
    // No explicit service account — use application-default credentials
    // (available automatically on Cloud Run and in emulator environments).
    app = initializeApp();
  }
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

async function deleteSubcollection(db: Firestore, path: string): Promise<void> {
  const snap = await db.collection(path).get();
  if (snap.empty) return;
  for (let i = 0; i < snap.docs.length; i += BATCH_LIMIT) {
    const slice = snap.docs.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    for (const doc of slice) {
      batch.delete(doc.ref);
    }
    await batch.commit();
  }
}

async function deleteByUserQuery(db: Firestore, collection: string, userId: string): Promise<void> {
  const snap = await db.collection(collection).where('userId', '==', userId).get();
  if (snap.empty) return;
  for (let i = 0; i < snap.docs.length; i += BATCH_LIMIT) {
    const slice = snap.docs.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    for (const doc of slice) {
      batch.delete(doc.ref);
    }
    await batch.commit();
  }
}
