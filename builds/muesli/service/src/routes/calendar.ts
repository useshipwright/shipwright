/**
 * Calendar route plugin — Google Calendar OAuth2 integration.
 *
 * POST   /api/calendar/connect    — Initiate OAuth2 flow, returns auth URL
 * GET    /api/calendar/callback   — OAuth2 callback, exchanges code for tokens
 * GET    /api/calendar/events     — List calendar events within date range
 * POST   /api/calendar/sync       — Incremental sync via stored sync tokens
 * DELETE /api/calendar/disconnect — Revoke access and remove tokens
 *
 * SECURITY:
 * - All routes require Firebase Auth JWT (inherited from auth middleware)
 * - OAuth2 state parameter bound to userId with 10-minute expiry
 * - State validated via HMAC signature (Calendar OAuth2 CSRF mitigation)
 * - Refresh tokens stored encrypted (threat model compliance)
 */

import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

import { CalendarEventsQuerySchema, type CalendarEventsQuery } from '../types/api.js';
import type { CalendarService } from '../services/calendar.js';

// ── Plugin options ──────────────────────────────────────────────────

export interface CalendarRoutesOptions {
  calendarService: CalendarService;
}

// ── Helper: convert Zod to Fastify JSON Schema ──────────────────────

function zodSchema(schema: z.ZodType): Record<string, unknown> {
  return (zodToJsonSchema as (...args: unknown[]) => Record<string, unknown>)(schema);
}

// ── Callback query schema ────────────────────────────────────────────

const CallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

type CallbackQuery = z.infer<typeof CallbackQuerySchema>;

// ── Route plugin ────────────────────────────────────────────────────

const calendarRoutes: FastifyPluginAsync<CalendarRoutesOptions> = async (
  app: FastifyInstance,
  opts: CalendarRoutesOptions,
) => {
  const { calendarService } = opts;

  // ── POST /api/calendar/connect ──────────────────────────────────
  app.post('/connect', async (request) => {
    const result = calendarService.generateConnectUrl(request.userId);
    return { data: { authUrl: result.authUrl } };
  });

  // ── GET /api/calendar/callback ──────────────────────────────────
  app.get<{ Querystring: CallbackQuery }>(
    '/callback',
    {
      schema: {
        querystring: zodSchema(CallbackQuerySchema),
      },
    },
    async (request, reply) => {
      const { code, state } = request.query;

      try {
        const result = await calendarService.handleCallback(request.userId, code, state);
        return { data: { connected: result.connected } };
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 400) {
          return reply.status(400).send({
            error: { code: 400, message: (err as Error).message },
          });
        }

        request.log.error({ err }, 'Calendar callback failed');
        return reply.status(500).send({
          error: { code: 500, message: 'Failed to connect calendar' },
        });
      }
    },
  );

  // ── GET /api/calendar/events ────────────────────────────────────
  app.get<{ Querystring: CalendarEventsQuery }>(
    '/events',
    {
      schema: {
        querystring: zodSchema(CalendarEventsQuerySchema),
      },
    },
    async (request, reply) => {
      const { timeMin, timeMax } = request.query;

      try {
        const events = await calendarService.listEvents(request.userId, timeMin, timeMax);
        return { data: { events } };
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 400) {
          return reply.status(400).send({
            error: { code: 400, message: (err as Error).message },
          });
        }

        request.log.error({ err }, 'Calendar event listing failed');
        return reply.status(503).send({
          error: { code: 503, message: 'Calendar service unavailable' },
        });
      }
    },
  );

  // ── POST /api/calendar/sync ─────────────────────────────────────
  app.post('/sync', async (request, reply) => {
    try {
      const result = await calendarService.sync(request.userId);
      return {
        data: {
          newMeetings: result.newMeetings,
          updatedMeetings: result.updatedMeetings,
          eventsProcessed: result.eventsProcessed,
        },
      };
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 400) {
        return reply.status(400).send({
          error: { code: 400, message: (err as Error).message },
        });
      }

      request.log.error({ err }, 'Calendar sync failed');
      return reply.status(503).send({
        error: { code: 503, message: 'Calendar sync failed' },
      });
    }
  });

  // ── DELETE /api/calendar/disconnect ─────────────────────────────
  app.delete('/disconnect', async (request, reply) => {
    try {
      await calendarService.disconnect(request.userId);
      return { data: { disconnected: true } };
    } catch (err) {
      request.log.error({ err }, 'Calendar disconnect failed');
      return reply.status(500).send({
        error: { code: 500, message: 'Failed to disconnect calendar' },
      });
    }
  });
};

export default calendarRoutes;
