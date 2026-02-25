import type { FastifySchema } from 'fastify';

const tokenMetadataSchema = {
  type: 'object',
  required: ['iat', 'exp', 'auth_time', 'iss', 'sign_in_provider'],
  properties: {
    iat: { type: 'integer' },
    exp: { type: 'integer' },
    auth_time: { type: 'integer' },
    iss: { type: 'string' },
    sign_in_provider: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const batchTokenResultSchema = {
  type: 'object',
  required: ['index', 'valid'],
  properties: {
    index: { type: 'integer', minimum: 0 },
    valid: { type: 'boolean' },
    uid: { type: 'string' },
    email: { type: ['string', 'null'] },
    email_verified: { type: 'boolean' },
    custom_claims: { type: 'object', additionalProperties: true },
    token_metadata: tokenMetadataSchema,
    error: { type: 'string', enum: ['expired', 'invalid', 'malformed', 'revoked'] },
  },
  additionalProperties: false,
} as const;

const batchSummarySchema = {
  type: 'object',
  required: ['total', 'valid', 'invalid'],
  properties: {
    total: { type: 'integer' },
    valid: { type: 'integer' },
    invalid: { type: 'integer' },
  },
  additionalProperties: false,
} as const;

export const batchVerifySchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['tokens'],
    properties: {
      tokens: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        maxItems: 25,
      },
      check_revoked: { type: 'boolean', default: false },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['results', 'summary'],
      properties: {
        results: {
          type: 'array',
          items: batchTokenResultSchema,
        },
        summary: batchSummarySchema,
      },
      additionalProperties: false,
    },
    400: {
      type: 'object',
      required: ['error', 'statusCode'],
      properties: {
        error: { type: 'string' },
        statusCode: { type: 'integer' },
      },
      additionalProperties: false,
    },
    429: {
      type: 'object',
      required: ['statusCode', 'error', 'message'],
      properties: {
        statusCode: { type: 'integer' },
        error: { type: 'string' },
        message: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
};
