import {
  ref, resp, json, body, object, param, arrayOf, plusErrors, publicEndpoint,
} from '../helpers';

const TAG = 'Onboarding & Recommendations';

const GENRE_VALUES = [
  'literary fiction', 'poetry', 'self-help', 'mystery', 'romance', 'business',
  'horror', 'sci-fi', 'historical fiction', 'biography', 'fantasy', 'non-fiction',
  'society & education', 'sport', 'crime', 'young adult', 'classics',
  'graphic novel', 'politics', 'health & lifestyle', 'travel',
];

const feelingsSchema = {
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: 200 },
  minItems: 3,
  maxItems: 3,
  description:
    'Exactly 3 — not "up to 3". Preset labels from the UI or freeform text, each ≤200 characters. These are embedded as part of the preference vector, so freeform answers work as well as presets.',
  example: ['hopeful', 'a bit unsettled', 'ready to think'],
};

const genresSchema = {
  type: 'array',
  items: { type: 'string', enum: GENRE_VALUES },
  minItems: 3,
  maxItems: 3,
  description:
    'Exactly 3, and each must be one of the 21 listed values — this is a closed enum, unlike `dislikes`. Note it is **not** the same vocabulary as `GET /genres`, which returns catalogue genres.',
  example: ['literary fiction', 'historical fiction', 'poetry'],
};

const dislikesSchema = {
  type: 'object',
  additionalProperties: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 } },
  default: {},
  description: [
    'Reading experiences to avoid, grouped by category. **Deliberately open-ended** — neither the category keys nor the labels inside them are validated against a fixed list, so the onboarding UI can add a category or reword a label without a backend release, and a mismatch degrades gracefully instead of failing the whole request. The only constraint is the 200-character cap on each label, since every one is embedded into the preference text.',
    '',
    'The categories the app currently sends are `emotionalTone`, `contentSensitivity`, `pacingStructure`, `writingStyle`, `genreFocus` and `commitmentLevel`.',
    '',
    'Two labels do more than feed the embedding — they apply **hard SQL filters** before the similarity search runs, in whichever category they appear: `long book (500+ pages)` and `series commitment`.',
  ].join('\n'),
  example: {
    emotionalTone: ['bleak endings'],
    contentSensitivity: ['graphic violence'],
    commitmentLevel: ['long book (500+ pages)'],
  },
};

const bookIdsSchema = {
  type: 'array',
  items: { type: 'integer', minimum: 1 },
  maxItems: 10,
  description: 'Up to 10 books the user says they already enjoyed. Optional.',
  example: [48213, 51002],
};

const guestIdParam = param('id', 'path', { type: 'string', format: 'uuid' },
  'The `guestSessionId` returned by `POST /recommendations`.',
  { example: 'f1e2d3c4-b5a6-4978-8b0c-1d2e3f4a5b6c' });

export const onboardingPaths = {
  '/api/v1/recommendations': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Run the onboarding quiz (guest)',
      description: [
        '**The entry point of the whole product.** Takes the quiz answers, embeds them as a preference vector, runs a pgvector similarity search over the catalogue, then generates a short reason per book with Gemini.',
        '',
        '**Unauthenticated by design** — this runs before an account exists. It always creates a fresh guest session and returns its id.',
        '',
        '### The three-step flow',
        '1. `POST /recommendations` → returns recommendations **and `guestSessionId`**. Store that id immediately; the next two steps are useless without it.',
        '2. `POST /guest-sessions/{id}/selections` → the books the user picked and swiped away.',
        '3. `POST /auth/signup` with `guestSessionId` → everything migrates onto the new account.',
        '',
        'Skip step 3 and the session expires after 72 hours (`GUEST_SESSION_TTL_HOURS`) and the answers are gone.',
        '',
        '### Caching',
        'Results are cached for 48 hours against a SHA-256 of the preferences. `displayName` is excluded from that hash, so two people with identical taste share a cache entry and the second gets an instant, Gemini-free response. A fresh guest session is created either way.',
        '',
        '### Rejections',
        'A guest has no rejection history to filter against, so nothing is excluded here. Books swiped away in step 2 are parked on the session and start applying the moment registration turns them into a user. A **signed-in** reader retaking the quiz goes through `PATCH /recommendations/refresh` instead, which does apply their history.',
        '',
        '**Rate limit:** 20 per hour per IP — every uncached call is a live Gemini request.',
      ].join('\n'),
      requestBody: body(object({
        displayName: {
          type: 'string', minLength: 1, maxLength: 100,
          description: 'The name entered in step 1. Used in the response copy; excluded from the cache key.',
          example: 'Ama',
        },
        feelings: feelingsSchema,
        genres: genresSchema,
        bookIds: bookIdsSchema,
        dislikes: dislikesSchema,
      }, ['displayName', 'feelings', 'genres'])),
      responses: {
        200: json('Ranked recommendations and a new guest session.',
          object({
            recommendations: arrayOf(ref('Recommendation')),
            guestSessionId: {
              type: 'string', format: 'uuid',
              description: '**Store this immediately.** Required by the next two steps of onboarding.',
              example: 'f1e2d3c4-b5a6-4978-8b0c-1d2e3f4a5b6c',
            },
            expiresAt: { type: 'string', format: 'date-time', example: '2026-08-17T10:00:00.000Z' },
          })),
        400: resp('ValidationError'),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/guest-sessions/{id}/selections': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Save the books picked during onboarding (guest)',
      description: [
        'Step 2 of onboarding. Records what the user chose from the recommendations screen, and what they swiped away.',
        '',
        'Nothing is applied yet — both lists sit on the guest session until signup, at which point chosen books land on the shelf and in the interaction log, and swiped-away books become the account’s **permanent** rejection history, filtered out of quiz results, the personalised feed, "you may also like" and recommendation emails from then on.',
        '',
        '**Rate limit:** 60 per 15 minutes per IP.',
      ].join('\n'),
      parameters: [guestIdParam],
      requestBody: body(object({
        chosenBookIds: {
          type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 5,
          description: 'Between 1 and 5 book ids.',
          example: [48213, 51002, 33871],
        },
        dislikedBookIds: {
          type: 'array', items: { type: 'integer', minimum: 1 }, default: [],
          description:
            'Books swiped away on the same screen. Optional, and deliberately unbounded — the recommendation list runs to 100 books and a thorough swiper can reject most of them.',
          example: [12045, 12046],
        },
      }, ['chosenBookIds'])),
      responses: {
        200: json('Saved to the guest session.',
          object({ ok: { type: 'boolean', example: true } }), { ok: true }),
        400: resp('ValidationError'),
        404: json('No such session, or it has expired (72 hours by default).', ref('Error'),
          { error: 'Guest session not found' }),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/guest-sessions/{id}/referral': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Park a referral code on a guest session',
      description:
        'Call this when the app holds both a guest session and a referral code — from a `/r/` link, a deep link, or the "Have an invite code?" field — so the code survives until signup.\n\nThe code is stored **as given and only resolved at signup**, so an unknown code reads as "no referral" then rather than failing onboarding here.\n\n**Rate limit:** 60 per 15 minutes per IP.',
      parameters: [guestIdParam],
      requestBody: body(object({
        referralCode: { type: 'string', pattern: '^[0-9A-Za-z]{6,32}$', example: 'K7M2QX' },
      }, ['referralCode'])),
      responses: {
        200: json('Code parked on the session.',
          object({ ok: { type: 'boolean', example: true } }), { ok: true }),
        400: resp('ValidationError'),
        404: json('No such session, or it has expired.', ref('Error'),
          { error: 'Guest session not found' }),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/guest-sessions/{id}': {
    get: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Check whether a guest session is still alive',
      description:
        'Call on app resume to decide between "carry on to registration" and "the quiz has expired, start again". Rate limited to 60 per 15 minutes per IP, tight enough that valid session UUIDs cannot be enumerated.',
      parameters: [guestIdParam],
      responses: {
        200: json('The session is alive.',
          object({
            guestSessionId: { type: 'string', format: 'uuid', example: 'f1e2d3c4-b5a6-4978-8b0c-1d2e3f4a5b6c' },
            displayName: { type: 'string', example: 'Ama' },
            expiresAt: { type: 'string', format: 'date-time', example: '2026-08-17T10:00:00.000Z' },
          })),
        400: json('Not a valid UUID.', ref('Error'), { error: 'Invalid guest session id' }),
        404: json('No such session, or it has expired.', ref('Error'),
          { error: 'Guest session not found' }),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/recommendations/preferences': {
    get: {
      tags: [TAG],
      summary: 'Get the saved reading preferences',
      description:
        'The caller’s stored taste profile as last saved by onboarding or a `PATCH /refresh`. Read-only — it touches neither the embedding nor the recommendation pipeline, so it is cheap to call on a settings screen.\n\nA 404 here means the user never completed onboarding, which is a normal state rather than an error.',
      responses: {
        200: json('The stored preferences.', object({ preferences: ref('ReadingPreferences') })),
        401: resp('Unauthorized'),
        404: json('No preferences saved — this account never completed onboarding.', ref('Error'),
          { error: 'No preferences found' }),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/recommendations/refresh': {
    patch: {
      tags: [TAG],
      summary: 'Retake the quiz as a signed-in user',
      description: [
        'The logged-in counterpart to `POST /recommendations`. Takes the **whole** quiz payload — this is not a granular patch, and omitting a field is a 400 rather than "leave it as it was".',
        '',
        '**What happens synchronously vs. in the background.** The preference fields are saved before the response returns. The embedding behind the personalised feed is regenerated *afterwards*, in the background, because it is a live Gemini call — so this endpoint cannot hang or fail on a slow Gemini. Until it completes, `GET /explore/personalized` keeps serving on the old embedding; the cache is invalidated once it lands.',
        '',
        '**`?includeRecommendations`.** Off by default, and that default is the point: most preference edits do not need the pgvector search and per-book Gemini explanations, which are the expensive part. Pass `true` when the user is actually retaking the quiz and expects a list back — this is what "Find your next read" on the Home tab uses. Shares the 48-hour cache with the guest flow.',
        '',
        '**The body is strict.** `dislikedBookIds` used to be accepted here and now belongs to `POST /selections`; sending it returns 400 rather than silently discarding the user’s swipes.',
        '',
        'Results never include books the caller has rejected or already shelved, whatever the body says — that comes from the server’s own record, so a minimal request still gets a clean list.',
        '',
        '**Requires Kinkané Plus. Rate limit:** 20 per hour.',
      ].join('\n'),
      parameters: [
        param('includeRecommendations', 'query', { type: 'boolean', default: false },
          'Also run the full recommendation pipeline and return a ranked list. Changes the response shape — see below.'),
      ],
      requestBody: body(object({
        feelings: feelingsSchema,
        genres: genresSchema,
        bookIds: bookIdsSchema,
        dislikes: dislikesSchema,
      }, ['feelings', 'genres'])),
      responses: {
        200: {
          description:
            'Preferences saved. The body depends on `includeRecommendations`: without it, the updated preferences; with it, the ranked recommendations instead.',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  object({ preferences: ref('ReadingPreferences') }),
                  object({ recommendations: arrayOf(ref('Recommendation')) }),
                ],
              },
            },
          },
        },
        400: resp('ValidationError'),
        ...plusErrors,
      },
    },
  },

  '/api/v1/recommendations/selections': {
    post: {
      tags: [TAG],
      summary: 'Save the books picked after retaking the quiz',
      description: [
        'The signed-in twin of `POST /guest-sessions/{id}/selections`. Call it after `PATCH /refresh?includeRecommendations=true`, with the picks made from that response.',
        '',
        'Unlike the guest version **nothing is parked for later** — there is already an account, so chosen books go onto the shelf and into the interaction log immediately, and swiped-away books go straight into the permanent rejection history. This is the only way a signed-in user’s rejections get recorded.',
        '',
        'A chosen book already on the shelf **keeps its existing status, note and source** — this call never overwrites the user’s own edits.',
        '',
        'Reader type is re-inferred from the new picks and written to the preference history, but the `readerType` shown in settings is deliberately left alone: a retake is evidence about taste, not a decision the user made about how they want to be labelled.',
        '',
        '**Requires Kinkané Plus** — it exists only to finish a retake, and only Plus members can start one. **Rate limit:** 20 per hour.',
      ].join('\n'),
      requestBody: body(object({
        chosenBookIds: {
          type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 5,
          description: 'Between 1 and 5 book ids.',
          example: [48213, 51002],
        },
        dislikedBookIds: {
          type: 'array', items: { type: 'integer', minimum: 1 }, default: [],
          description: 'Books swiped away. Additive to the existing rejection history, never replacing it.',
          example: [12045],
        },
      }, ['chosenBookIds'])),
      responses: {
        200: json('Saved to the account.',
          object({
            readerType: {
              type: 'string', nullable: true,
              description: 'Freshly inferred from the new picks. `null` if inference failed — not an error.',
              example: 'The Wanderer',
            },
            books: arrayOf(object({
              id: { type: 'integer', example: 48213 },
              title: { type: 'string', example: 'Girl, Woman, Other' },
              coverUrl: { type: 'string', format: 'uri', nullable: true },
            })),
          })),
        400: json('Validation failed, or one of the book ids does not exist.', ref('ValidationError')),
        ...plusErrors,
      },
    },
  },
};
