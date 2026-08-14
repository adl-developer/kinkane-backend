import {
  ref, resp, json, body, object, param, arrayOf, authErrors, publicEndpoint,
} from '../helpers';

const TAG = 'Referrals';

const shareResponse = object({
  code: {
    type: 'string',
    description: 'The caller’s referral code. Minted on first call to `/me` and stable from then on.',
    example: 'K7M2QX',
  },
  link: { type: 'string', format: 'uri', example: 'https://kinkane.app/r/K7M2QX/ama-boateng' },
  message: {
    type: 'string',
    description: 'Generic prewritten share text.',
    example: 'I’ve been using Kinkané to find my next read — join me:',
  },
  whatsapp: { type: 'string', format: 'uri', description: 'Ready-to-open WhatsApp share URL.', example: 'https://wa.me/?text=…' },
  sms: { type: 'string', format: 'uri', example: 'sms:?body=…' },
  email: object({
    subject: { type: 'string', example: 'Something for your reading list' },
    body: { type: 'string', example: 'I’ve been using Kinkané…' },
    mailto: { type: 'string', format: 'uri', example: 'mailto:?subject=…&body=…' },
  }),
  copy: { type: 'string', description: 'Plain text for a copy-to-clipboard button.', example: 'https://kinkane.app/r/K7M2QX/ama-boateng' },
  videoUrl: {
    type: 'string', format: 'uri',
    description: 'The marketing video linked from every invite. Configurable without a deploy.',
    example: 'https://kinkane.app/about',
  },
});

export const referralPaths = {
  '/api/v1/referrals/leaderboard': {
    get: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'The "Around the World" standings',
      description:
        'Public standings for the referral competition — rank, first name, country and points.\n\nDeliberately unauthenticated: the leaderboard is a marketing surface as much as a product feature. Only first names are exposed.',
      parameters: [
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          'How many places to return (capped at 100).'),
      ],
      responses: {
        200: json('The standings.',
          object({
            leaderboard: arrayOf(object({
              rank: { type: 'integer', example: 1 },
              name: { type: 'string', description: 'First name only.', example: 'Ama' },
              country: {
                type: 'string', nullable: true,
                description: 'ISO-3166 alpha-2, or null when the country was never resolved — a supported state, not an error.',
                example: 'GH',
              },
              points: { type: 'integer', example: 340 },
            })),
          })),
        400: resp('ValidationError'),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/referrals/clicks': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Report a referral link tap the server never saw',
      description: [
        'When a universal link (iOS) or app link (Android) opens the app directly, **the OS resolves the path locally and makes no HTTP request** — so the `/r/...` redirect never fires and the server has no idea the link was tapped. The app calls this instead, once, when it launches from a referral link.',
        '',
        'Unauthenticated, because the tap happens before there is an account.',
        '',
        '**Always returns 202, whether or not the code exists**, so this cannot be used to probe which codes are real.',
        '',
        '**Rate limit:** 120 per 15 minutes — matched to the `/r` redirect’s budget, since it is the same event arriving by a different route.',
      ].join('\n'),
      requestBody: body(object({
        code: { type: 'string', pattern: '^[0-9A-Za-z]{6,32}$', example: 'K7M2QX' },
        channel: {
          type: 'string',
          enum: ['whatsapp', 'sms', 'email', 'copy', 'link', 'app'],
          description: 'How the link reached them, for attribution.',
          example: 'whatsapp',
        },
      }, ['code'])),
      responses: {
        202: json('Recorded — or silently discarded if the code was unknown.',
          object({ ok: { type: 'boolean', example: true } }), { ok: true }),
        400: json('Malformed code.', ref('ValidationError')),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/referrals/me': {
    get: {
      tags: [TAG],
      summary: 'Get the caller’s referral link and share payloads',
      description:
        'Returns the code — **minting it on first call** — plus prebuilt share text for each channel, so the client never has to compose the copy itself.\n\nOpen to every signed-up account, **including lapsed ones**. Referral is deliberately not Plus-gated: the competition exists partly to bring lapsed members back, and gating it would take it away from exactly those users.',
      responses: {
        200: json('The caller’s referral kit.', shareResponse),
        ...authErrors,
      },
    },
  },

  '/api/v1/referrals/me/rotate': {
    post: {
      tags: [TAG],
      summary: 'Issue a new referral code',
      description:
        'Mints a new code and revokes the old one — for when a link was shared somewhere the user regrets.\n\n**Referrals already attributed are unaffected**; only future taps on the old link stop working.',
      responses: {
        200: json('The new referral kit. Same shape as `GET /referrals/me`.', shareResponse),
        ...authErrors,
      },
    },
  },

  '/api/v1/referrals/me/stats': {
    get: {
      tags: [TAG],
      summary: 'Get the caller’s own standing',
      description:
        'The caller’s funnel and score: clicks, signups, points broken down by how they were earned, whether they have closed a circuit, and which countries their code has reached.\n\n**Deliberately carries no identities** of the people they referred — a referrer learns that someone in Ghana signed up, never who.',
      responses: {
        200: json('The caller’s stats.',
          object({
            clicks: { type: 'integer', example: 84 },
            signups: { type: 'integer', example: 12 },
            countriesReached: {
              type: 'array', items: { type: 'string' },
              description: 'ISO-3166 alpha-2 codes their referrals signed up from.',
              example: ['GH', 'GB', 'US', 'NG'],
            },
            points: { type: 'integer', example: 340 },
            pointsByKind: {
              type: 'object',
              additionalProperties: { type: 'integer' },
              description: 'Points grouped by how they were earned.',
              example: { signup: 240, new_country: 80, circuit: 20 },
            },
            hasCircuit: {
              type: 'boolean',
              description: 'Whether they have closed a circuit in the "Around the World" competition.',
              example: false,
            },
            country: {
              type: 'string', nullable: true,
              description: 'The caller’s own country, or null if it was never resolved.',
              example: 'GH',
            },
          })),
        ...authErrors,
      },
    },
  },

  '/api/v1/referrals/invite': {
    post: {
      tags: [TAG],
      summary: 'Email an invite',
      description:
        'Sends the caller’s invite link to one address.\n\nReturns **202, not 200** — the mail is queued, not yet delivered, and a later bounce is not reported here.\n\n**Rate limit: 20 per hour**, tighter than the rest of this router. This is the one endpoint that sends mail on someone else’s behalf, which makes it the one that could be turned into a spam cannon; 20 an hour is generous for a person and useless for a script.',
      requestBody: body(object({
        email: { type: 'string', format: 'email', example: 'friend@example.com' },
      }, ['email'])),
      responses: {
        202: json('Queued for delivery.',
          object({ queued: { type: 'boolean', example: true } }), { queued: true }),
        400: json('Invalid email address.', ref('ValidationError')),
        ...authErrors,
      },
    },
  },
};
