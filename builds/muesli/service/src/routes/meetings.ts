/**
 * Meeting CRUD route plugin.
 *
 * Registers all /api/meetings endpoints with Zod-validated schemas
 * converted to JSON Schema for Fastify's Ajv validation (ADR-011).
 *
 * All responses use the standard envelope: { data: T, meta?: { cursor, hasMore } }
 */

import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  CreateMeetingBodySchema,
  UpdateMeetingBodySchema,
  UpdateSpeakerBodySchema,
  EditNoteBodySchema,
  IdParamSchema,
  SpeakerIdParamSchema,
  NoteVersionParamSchema,
  PaginationQuerySchema,
  type CreateMeetingBody,
  type UpdateMeetingBody,
  type UpdateSpeakerBody,
  type EditNoteBody,
  type IdParam,
} from '../types/api.js';
import type { MeetingService } from '../services/meeting.js';

// ── Extended query schema for listing meetings ──────────────────────

const ListMeetingsQuerySchema = PaginationQuerySchema.extend({
  status: z.enum(['recording', 'processing', 'ready', 'failed']).optional(),
  isStarred: z
    .string()
    .transform((v) => v === 'true')
    .optional(),
  tag: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  attendee: z.string().optional(),
  sortBy: z.enum(['createdAt', 'startedAt', 'title']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

type ListMeetingsQuery = z.infer<typeof ListMeetingsQuerySchema>;

// ── Transcript query schema ─────────────────────────────────────────

const TranscriptQuerySchema = PaginationQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

// ── Plugin options ──────────────────────────────────────────────────

export interface MeetingRoutesOptions {
  meetingService: MeetingService;
}

// ── Helper: convert Zod to Fastify JSON Schema ──────────────────────

function zodSchema(schema: z.ZodType): Record<string, unknown> {
  // Cast via unknown to avoid TS2589 deep instantiation with zodToJsonSchema generics
  return (zodToJsonSchema as (...args: unknown[]) => Record<string, unknown>)(schema);
}

// ── Route plugin ────────────────────────────────────────────────────

const meetingRoutes: FastifyPluginAsync<MeetingRoutesOptions> = async (
  app: FastifyInstance,
  opts: MeetingRoutesOptions,
) => {
  const { meetingService } = opts;

  // ── POST /api/meetings ────────────────────────────────────────────
  app.post<{ Body: CreateMeetingBody }>(
    '/',
    {
      schema: {
        body: zodSchema(CreateMeetingBodySchema),
      },
    },
    async (request, reply) => {
      const meeting = await meetingService.create({
        userId: request.userId,
        title: request.body.title,
        calendarEventId: request.body.calendarEventId,
        attendees: request.body.attendees,
        tags: request.body.tags,
      });

      return reply.code(201).send({ data: meeting });
    },
  );

  // ── GET /api/meetings ─────────────────────────────────────────────
  app.get<{ Querystring: ListMeetingsQuery }>(
    '/',
    {
      schema: {
        querystring: zodSchema(ListMeetingsQuerySchema),
      },
    },
    async (request) => {
      const q = request.query;
      const result = await meetingService.list({
        userId: request.userId,
        cursor: q.cursor,
        limit: q.limit,
        dateFrom: q.dateFrom,
        dateTo: q.dateTo,
        attendee: q.attendee,
        tag: q.tag,
        status: q.status,
        isStarred: q.isStarred as boolean | undefined,
        sortBy: q.sortBy,
        sortOrder: q.sortOrder,
      });

      return {
        data: result.meetings,
        meta: {
          cursor: result.cursor,
          hasMore: result.hasMore,
        },
      };
    },
  );

  // ── GET /api/meetings/:id ─────────────────────────────────────────
  app.get<{ Params: IdParam }>(
    '/:id',
    {
      schema: {
        params: zodSchema(IdParamSchema),
      },
    },
    async (request, reply) => {
      const meeting = await meetingService.getById(
        request.params.id,
        request.userId,
      );
      if (!meeting) {
        return reply.code(404).send({
          error: { code: 404, message: 'Meeting not found' },
        });
      }
      return { data: meeting };
    },
  );

  // ── PUT /api/meetings/:id ─────────────────────────────────────────
  app.put<{ Params: IdParam; Body: UpdateMeetingBody }>(
    '/:id',
    {
      schema: {
        params: zodSchema(IdParamSchema),
        body: zodSchema(UpdateMeetingBodySchema),
      },
    },
    async (request, reply) => {
      const updated = await meetingService.update(
        request.params.id,
        request.userId,
        request.body,
      );
      if (!updated) {
        return reply.code(404).send({
          error: { code: 404, message: 'Meeting not found' },
        });
      }
      return { data: updated };
    },
  );

  // ── DELETE /api/meetings/:id ──────────────────────────────────────
  app.delete<{ Params: IdParam }>(
    '/:id',
    {
      schema: {
        params: zodSchema(IdParamSchema),
      },
    },
    async (request, reply) => {
      const deleted = await meetingService.delete(
        request.params.id,
        request.userId,
      );
      if (!deleted) {
        return reply.code(404).send({
          error: { code: 404, message: 'Meeting not found' },
        });
      }
      return { data: { id: request.params.id, deleted: true } };
    },
  );

  // ── GET /api/meetings/:id/transcript ──────────────────────────────
  app.get<{ Params: IdParam; Querystring: z.infer<typeof TranscriptQuerySchema> }>(
    '/:id/transcript',
    {
      schema: {
        params: zodSchema(IdParamSchema),
        querystring: zodSchema(TranscriptQuerySchema),
      },
    },
    async (request) => {
      const result = await meetingService.getTranscript(
        request.params.id,
        request.userId,
        { cursor: request.query.cursor, limit: request.query.limit },
      );
      return {
        data: result.segments,
        meta: {
          cursor: result.cursor,
          hasMore: result.hasMore,
        },
      };
    },
  );

  // ── GET /api/meetings/:id/speakers ────────────────────────────────
  app.get<{ Params: IdParam }>(
    '/:id/speakers',
    {
      schema: {
        params: zodSchema(IdParamSchema),
      },
    },
    async (request) => {
      const speakers = await meetingService.getSpeakers(
        request.params.id,
        request.userId,
      );
      return { data: speakers };
    },
  );

  // ── PUT /api/meetings/:id/speakers/:speakerId ─────────────────────
  app.put<{
    Params: z.infer<typeof SpeakerIdParamSchema>;
    Body: UpdateSpeakerBody;
  }>(
    '/:id/speakers/:speakerId',
    {
      schema: {
        params: zodSchema(SpeakerIdParamSchema),
        body: zodSchema(UpdateSpeakerBodySchema),
      },
    },
    async (request, reply) => {
      const updated = await meetingService.updateSpeaker(
        request.params.id,
        request.params.speakerId,
        request.userId,
        request.body,
      );
      if (!updated) {
        return reply.code(404).send({
          error: { code: 404, message: 'Meeting or speaker not found' },
        });
      }
      return { data: { updated: true } };
    },
  );

  // ── GET /api/meetings/:id/notes ───────────────────────────────────
  app.get<{ Params: IdParam }>(
    '/:id/notes',
    {
      schema: {
        params: zodSchema(IdParamSchema),
      },
    },
    async (request) => {
      const notes = await meetingService.getNotes(
        request.params.id,
        request.userId,
      );
      return { data: notes };
    },
  );

  // ── GET /api/meetings/:id/notes/latest ────────────────────────────
  app.get<{ Params: IdParam }>(
    '/:id/notes/latest',
    {
      schema: {
        params: zodSchema(IdParamSchema),
      },
    },
    async (request, reply) => {
      const note = await meetingService.getLatestNote(
        request.params.id,
        request.userId,
      );
      if (!note) {
        return reply.code(404).send({
          error: { code: 404, message: 'No notes generated yet' },
        });
      }
      return { data: note };
    },
  );

  // ── GET /api/meetings/:id/notes/:version ──────────────────────────
  app.get<{ Params: z.infer<typeof NoteVersionParamSchema> }>(
    '/:id/notes/:version',
    {
      schema: {
        params: zodSchema(NoteVersionParamSchema),
      },
    },
    async (request, reply) => {
      const note = await meetingService.getNote(
        request.params.id,
        request.params.version,
        request.userId,
      );
      if (!note) {
        return reply.code(404).send({
          error: { code: 404, message: 'Note version not found' },
        });
      }
      return { data: note };
    },
  );

  // ── PUT /api/meetings/:id/notes/:version ──────────────────────────
  app.put<{
    Params: z.infer<typeof NoteVersionParamSchema>;
    Body: EditNoteBody;
  }>(
    '/:id/notes/:version',
    {
      schema: {
        params: zodSchema(NoteVersionParamSchema),
        body: zodSchema(EditNoteBodySchema),
      },
    },
    async (request, reply) => {
      const updated = await meetingService.updateNote(
        request.params.id,
        request.params.version,
        request.userId,
        request.body.sections,
      );
      if (!updated) {
        return reply.code(404).send({
          error: { code: 404, message: 'Note version not found' },
        });
      }
      return { data: updated };
    },
  );
};

export default meetingRoutes;
