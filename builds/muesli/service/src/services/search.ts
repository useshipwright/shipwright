/**
 * Search service — full-text and semantic search across meetings.
 *
 * SECURITY: All queries are scoped to the authenticated user's data.
 * Vector search always includes userId filter to prevent cross-user
 * data leakage (see threat model: "Cross-meeting data leakage via semantic search").
 *
 * Full-text search uses tokenized array fields with array-contains-any queries
 * (ADR-002). Tokenization: lowercase, split on whitespace/punctuation, deduplicate,
 * max 10 tokens per query (Firestore limit).
 */

import type { EmbeddingAdapter } from '../adapters/embedding.js';
import type {
  FirestoreAdapter,
  VectorSearchResult,
} from '../adapters/firestore.js';
import type { Meeting, ActionItem, MeetingStatus } from '../types/domain.js';

// ── Full-text search ─────────────────────────────────────────────────

export interface FullTextSearchParams {
  query: string;
  userId: string;
  type?: 'meetings' | 'transcripts' | 'notes' | 'actions';
  dateFrom?: Date;
  dateTo?: Date;
  status?: MeetingStatus;
  cursor?: string;
  limit?: number;
}

export interface FullTextSearchResult {
  meetings: Meeting[];
  actions: ActionItem[];
  cursor?: string;
  hasMore: boolean;
}

// ── Semantic search ──────────────────────────────────────────────────

export interface SemanticSearchParams {
  query: string;
  userId: string;
  limit?: number;
  filters?: {
    meetingId?: string;
    sourceType?: 'transcript' | 'notes';
    dateFrom?: Date;
    dateTo?: Date;
  };
}

export interface SemanticSearchResult {
  results: VectorSearchResult[];
}

// ── Tokenizer ────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'it', 'of', 'in', 'to', 'and', 'or', 'for',
  'on', 'at', 'by', 'with', 'from', 'as', 'be', 'was', 'are', 'were',
  'been', 'has', 'had', 'do', 'did', 'not', 'but', 'if', 'so', 'no',
  'up', 'out', 'that', 'this', 'than', 'its', 'my', 'me', 'we', 'he',
  'she', 'they', 'you', 'i', 'am',
]);

/**
 * Tokenize a search query into lowercase words suitable for
 * Firestore array-contains-any queries.
 *
 * - Lowercase and split on whitespace/punctuation
 * - Deduplicate
 * - Filter stop words
 * - Limit to 10 tokens (Firestore array-contains-any max disjunctions)
 */
export function tokenizeQuery(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));

  const unique = [...new Set(tokens)];
  return unique.slice(0, 10);
}

// ── Service ──────────────────────────────────────────────────────────

export interface SearchServiceDeps {
  firestoreAdapter: FirestoreAdapter;
  embeddingAdapter: EmbeddingAdapter;
}

export type SearchService = ReturnType<typeof createSearchService>;

export function createSearchService(deps: SearchServiceDeps) {
  const { firestoreAdapter, embeddingAdapter } = deps;

  return {
    /**
     * Full-text search across meetings and action items.
     *
     * Tokenizes the query, then queries Firestore searchTokens fields
     * using array-contains-any (max 10 disjunctions per ADR-002).
     *
     * SECURITY: userId is always included in Firestore queries.
     */
    async fullTextSearch(params: FullTextSearchParams): Promise<FullTextSearchResult> {
      const { query, userId, type, cursor, limit = 20 } = params;

      const tokens = tokenizeQuery(query);
      if (tokens.length === 0) {
        return { meetings: [], actions: [], hasMore: false };
      }

      let meetings: Meeting[] = [];
      let actions: ActionItem[] = [];
      let nextCursor: string | undefined;
      let hasMore = false;

      // Search meetings (includes transcripts and notes context via searchTokens)
      if (!type || type === 'meetings' || type === 'transcripts' || type === 'notes') {
        const meetingResult = await firestoreAdapter.searchMeetings(
          userId,
          tokens,
          cursor,
          limit + 1,
        );
        meetings = meetingResult.meetings;
        if (meetings.length > limit) {
          hasMore = true;
          meetings = meetings.slice(0, limit);
          nextCursor = meetingResult.cursor;
        }
      }

      // Search action items
      if (!type || type === 'actions') {
        const actionResult = await firestoreAdapter.searchActions(
          userId,
          tokens,
          cursor,
          limit + 1,
        );
        actions = actionResult.actions;
        if (actions.length > limit) {
          hasMore = true;
          actions = actions.slice(0, limit);
          if (!nextCursor) {
            nextCursor = actionResult.cursor;
          }
        }
      }

      return {
        meetings,
        actions,
        cursor: nextCursor,
        hasMore,
      };
    },

    /**
     * Semantic search via vector similarity.
     *
     * 1. Embeds the query text
     * 2. Performs Firestore vector nearest-neighbor search scoped to userId
     * 3. Returns ranked results with similarity scores
     *
     * SECURITY: userId is always passed to vectorSearch to enforce tenant isolation.
     */
    async semanticSearch(params: SemanticSearchParams): Promise<SemanticSearchResult> {
      const { query, userId, limit = 10, filters } = params;

      // Generate query embedding
      const [queryVector] = await embeddingAdapter.embed([query]);

      // Vector search — userId is mandatory for tenant isolation
      const results = await firestoreAdapter.vectorSearch({
        queryVector,
        userId,
        limit,
        filters,
      });

      return { results };
    },
  };
}
