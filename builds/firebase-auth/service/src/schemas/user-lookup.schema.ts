import type { FastifySchema } from 'fastify';

const providerInfoSchema = {
  type: 'object',
  required: ['provider_id', 'uid'],
  properties: {
    provider_id: { type: 'string' },
    uid: { type: 'string' },
    email: { type: ['string', 'null'] },
    display_name: { type: ['string', 'null'] },
    photo_url: { type: ['string', 'null'] },
  },
  additionalProperties: false,
} as const;

const userTimestampsSchema = {
  type: 'object',
  required: ['creation_time', 'last_sign_in_time'],
  properties: {
    creation_time: { type: 'string' },
    last_sign_in_time: { type: 'string' },
    last_refresh_time: { type: ['string', 'null'] },
  },
  additionalProperties: false,
} as const;

export const userLookupSchema: FastifySchema = {
  params: {
    type: 'object',
    required: ['uid'],
    properties: {
      uid: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        pattern: '^[a-zA-Z0-9_-]+$',
      },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: [
        'uid',
        'email_verified',
        'disabled',
        'provider_data',
        'metadata',
      ],
      properties: {
        uid: { type: 'string' },
        email: { type: ['string', 'null'] },
        email_verified: { type: 'boolean' },
        display_name: { type: ['string', 'null'] },
        photo_url: { type: ['string', 'null'] },
        phone_number: { type: ['string', 'null'] },
        disabled: { type: 'boolean' },
        custom_claims: {
          oneOf: [
            { type: 'object', additionalProperties: true },
            { type: 'null' },
          ],
        },
        provider_data: {
          type: 'array',
          items: providerInfoSchema,
        },
        metadata: userTimestampsSchema,
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
    404: {
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
