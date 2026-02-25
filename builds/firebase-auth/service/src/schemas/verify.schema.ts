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

export const verifySchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['token'],
    properties: {
      token: { type: 'string', minLength: 1 },
      check_revoked: { type: 'boolean', default: false },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: [
        'uid',
        'email',
        'email_verified',
        'name',
        'picture',
        'custom_claims',
        'token_metadata',
      ],
      properties: {
        uid: { type: 'string' },
        email: { type: ['string', 'null'] },
        email_verified: { type: ['boolean', 'null'] },
        name: { type: ['string', 'null'] },
        picture: { type: ['string', 'null'] },
        custom_claims: { type: 'object', additionalProperties: true },
        token_metadata: tokenMetadataSchema,
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
    401: {
      type: 'object',
      required: ['error', 'statusCode'],
      properties: {
        error: { type: 'string' },
        statusCode: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
};
