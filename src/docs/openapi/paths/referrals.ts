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
        '',
        'Exactly one of `referralCode` (preferred) or `code` (deprecated) is required.',
      ].join('\n'),
      requestBody: body(object({
        referralCode: { type: 'string', pattern: '^[0-9A-Za-z]{6,32}$', example: 'K7M2QX4B9C' },
        code: {
          type: 'string',
          deprecated: true,
          description: '**Deprecated — use `referralCode`.** Still accepted so that already-installed app builds, which cannot be updated retroactively, keep reporting clicks. Ignored when `referralCode` is present.',
          example: 'K7M2QX4B9C',
        },
        channel: {
          type: 'string',
          enum: ['whatsapp', 'sms', 'email', 'copy', 'link', 'app'],
          description: 'How the link reached them, for attribution. Note this accepts six values, two more than `POST /referrals/shares` — a click can arrive from an email link or an app launch; a share sheet cannot be either.',
          example: 'whatsapp',
        },
      })),
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
        'The caller’s funnel and score: the invite funnel, points broken down by how they were earned, whether they have closed a circuit, and which countries their code has reached.\n\n**`sent`, `successful` and `pending` do not reconcile, and are not meant to.** `sent` counts invites and shares this user initiated; `successful` and `pending` count people who actually arrived, which includes everyone who found the link second-hand — a forwarded WhatsApp message, a link pasted into a group chat. Forcing the three to add up would mean either discarding those signups or inventing sends that never happened.\n\n**Carries no identities.** For the people themselves, at a redaction, see `/referrals/me/network`.',
      responses: {
        200: json('The caller’s stats.',
          object({
            clicks: { type: 'integer', description: 'Unique link taps, deduped on hashed IP and user agent, bots excluded.', example: 84 },
            signups: { type: 'integer', description: 'Everyone who signed up under this code, credited or not.', example: 18 },
            sent: { type: 'integer', description: 'Invites emailed plus shares initiated. See the note above on why this does not reconcile with the other two.', example: 18 },
            successful: { type: 'integer', description: 'Signups whose email is verified — the ones that actually scored.', example: 12 },
            pending: { type: 'integer', description: 'Signed up but not yet verified. The one state a referrer can act on.', example: 6 },
            countriesReached: {
              type: 'array', items: { type: 'string' },
              description: 'ISO-3166 alpha-2 codes reached across the **whole network**, any depth — not just direct referrals. Matches what `/referrals/me/network` reports, so the two cannot disagree about a figure both screens label "Countries Reached".',
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

  '/api/v1/referrals/me/network': {
    get: {
      tags: [TAG],
      summary: 'Get the caller’s journey map and globe data',
      description: [
        'Everyone below the caller — direct and indirect, any depth — plus the summary the journey map and globe display.',
        '',
        '**Names are redacted to first name plus last initial** ("Amara S."), with a city and nothing else. This is a deliberate narrowing of an earlier position that referees should not be surfaced to their referrer at all: the journey map is the feature, and a map of anonymous dots is not one. `id` is an opaque handle used only to draw edges between nodes.',
        '',
        '`city`, `lat` and `lng` are **null for any account created before city resolution existed** — the original IP was only ever stored as a one-way hash, so it cannot be recovered. Those users are filled in the next time they sign in.',
        '',
        '`longestChain.links` counts hops, not people: five names are four links. The caller is not in `nodes` and not in `hops` — they are the root of the view.',
      ].join('\n'),
      responses: {
        200: json('The caller’s network.',
          object({
            summary: object({
              directReferrals: { type: 'integer', description: 'People the caller personally invited.', example: 12 },
              networkTotal: { type: 'integer', description: 'Everyone below them, any depth.', example: 26 },
              degreesOfInfluence: { type: 'integer', description: 'Hops to the furthest referral.', example: 4 },
              citiesReached: { type: 'integer', example: 26 },
              countriesReached: { type: 'integer', example: 14 },
              byDegree: arrayOf(object({
                degree: { type: 'integer', example: 1 },
                count: { type: 'integer', example: 12 },
              })),
              longestChain: object({
                links: { type: 'integer', description: 'Hops, not people.', example: 4 },
                hops: arrayOf(object({
                  name: { type: 'string', example: 'Amara S.' },
                  city: { type: 'string', nullable: true, example: 'Paris' },
                  countryCode: { type: 'string', nullable: true, example: 'FR' },
                })),
              }),
            }),
            nodes: arrayOf(object({
              id: { type: 'integer', description: 'Opaque handle, used only to draw edges.', example: 4821 },
              name: { type: 'string', description: 'First name plus last initial.', example: 'Amara S.' },
              city: { type: 'string', nullable: true, example: 'Paris' },
              countryCode: { type: 'string', nullable: true, example: 'FR' },
              lat: { type: 'number', nullable: true, description: 'City centroid, never a person’s location.', example: 48.85 },
              lng: { type: 'number', nullable: true, example: 2.35 },
              referrerId: { type: 'integer', description: 'The caller’s own id for a first-degree node.', example: 100 },
              degree: { type: 'integer', description: '1 = personally invited.', example: 1 },
              directReferrals: { type: 'integer', description: 'How many this node has themselves referred.', example: 3 },
              signedUpAt: { type: 'string', format: 'date-time' },
              credited: { type: 'boolean', description: 'False while they have signed up but not yet verified.', example: true },
            })),
          })),
        ...authErrors,
      },
    },
  },

  '/api/v1/referrals/analytics': {
    get: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Campaign-wide referral performance',
      description: [
        'Totals, one weekly bucket per week of the campaign for the sent/converted and cumulative charts, and the top referrers.',
        '',
        'Unauthenticated, like the leaderboard: every figure here is an aggregate over the whole campaign, and the only people named are top referrers at the same first-name-only redaction the leaderboard already uses.',
        '',
        '**`topReferrers` ranks by signups, not points** — a different ordering from `/referrals/leaderboard`. Someone with three cross-continent referrals outscores someone with fifteen domestic ones, so "top referrer" means two different people depending on which question is asked. Both figures are returned so a client can show either without a second call.',
        '',
        'Weeks are Monday-based UTC and **every bucket in the window is returned, zero or not** — a chart that silently omits a quiet week draws a straight line across it, which reads as steady rather than as quiet.',
        '',
        '**The window is anchored to the campaign, not to today.** `weekly` runs from week 1 of the competition through the week in progress, so the array grows by one entry a week and a given `weekNumber` always refers to the same dates. Label bars from `weekNumber` rather than from the array index. The anchor is `REFERRAL_CAMPAIGN_STARTS_AT`, snapped back to the Monday on or before it — where that is mid-week, week 1 is a partial week and will read low. Unconfigured, it falls back to the earliest invite ever sent.',
      ].join('\n'),
      responses: {
        200: json('Campaign performance.',
          object({
            totals: object({
              sent: { type: 'integer', example: 1247 },
              clicks: { type: 'integer', description: 'Unique link taps, deduped on hashed IP and user agent, bots excluded. The denominator of conversionRate.', example: 1247 },
              signups: { type: 'integer', description: 'Everyone who signed up, credited or not.', example: 412 },
              successful: { type: 'integer', description: 'Verified signups — the ones that scored.', example: 389 },
              conversionRate: { type: 'number', description: '`successful ÷ clicks`, as a percentage to one decimal. 0 when there are no clicks yet. Against clicks rather than `sent`, because a link forwarded around a group chat is one share and many arrivals — dividing by `sent` is not a rate and can exceed 100%. Reads high wherever clients are not reporting app-opened taps via `POST /referrals/clicks`.', example: 31.2 },
              countries: { type: 'integer', example: 14 },
              continents: { type: 'integer', description: 'Derived by joining to the country table, not by counting distinct country codes.', example: 3 },
            }),
            weekly: arrayOf(object({
              weekNumber: { type: 'integer', description: 'Week of the campaign, 1-based. What a chart labels "Wk 3".', example: 3 },
              weekStart: { type: 'string', format: 'date', description: 'Monday, UTC.', example: '2026-07-06' },
              weekEnd: { type: 'string', format: 'date', description: 'The Sunday that closes the bucket, inclusive.', example: '2026-07-12' },
              sent: { type: 'integer', example: 190 },
              converted: { type: 'integer', example: 61 },
              cumulative: { type: 'integer', description: 'Running total of converted.', example: 284 },
            })),
            topReferrers: arrayOf(object({
              rank: { type: 'integer', example: 1 },
              name: { type: 'string', description: 'First name only.', example: 'Kwame' },
              country: { type: 'string', nullable: true, example: 'GH' },
              signups: { type: 'integer', description: 'Credited referrals. What this list is ranked by.', example: 47 },
              points: { type: 'integer', example: 620 },
            })),
          })),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/referrals/map': {
    get: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Anonymous city pins for the globe',
      description: [
        'Where the campaign has reached, with a headcount per city and **no identities at all** — no names, no ids, no way to tell which pin is which person. That is what makes it safe to show a stranger’s activity to a logged-out visitor: the globe conveys that the campaign is spreading without saying who is doing the spreading.',
        '',
        'Cities with no coordinates are **omitted rather than placed at (0, 0)**, which would drop a pin in the Gulf of Guinea for every unresolvable user.',
      ].join('\n'),
      responses: {
        200: json('City pins.',
          object({
            pins: arrayOf(object({
              city: { type: 'string', example: 'Paris' },
              countryCode: { type: 'string', nullable: true, example: 'FR' },
              lat: { type: 'number', example: 48.85 },
              lng: { type: 'number', example: 2.35 },
              count: { type: 'integer', example: 7 },
            })),
          })),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/referrals/shares': {
    post: {
      tags: [TAG],
      summary: 'Report that the caller opened a share sheet',
      description: [
        'The soft half of the `sent` figure. This server never learns whether anything was actually sent on WhatsApp, SMS or a copied link — only that the user opened the share sheet.',
        '',
        'It is recorded anyway, because the alternative is a screen that reads **"Sent 0"** to someone who has shared their link twenty times, which reads as broken rather than as honest.',
        '',
        'Returns **202, not 201** — what is being recorded is an intention, and a stronger status would overstate what we know.',
        '',
        '**Rate limit: 60 per hour.** A share is the cheapest row in this feature to manufacture: one tap, no recipient.',
      ].join('\n'),
      requestBody: body(object({
        channel: { type: 'string', enum: ['whatsapp', 'sms', 'copy', 'link'], example: 'whatsapp' },
      }, ['channel'])),
      responses: {
        202: json('Recorded.', object({ recorded: { type: 'boolean', example: true } }), { recorded: true }),
        400: json('Unknown channel.', ref('ValidationError')),
        ...authErrors,
      },
    },
  },

  '/api/v1/referrals/invite': {
    post: {
      tags: [TAG],
      summary: 'Email an invite',
      description:
        'Sends the caller’s invite link to one address, and counts towards `sent` on `/referrals/me/stats`.\n\n**Re-inviting an address already invited is a no-op for the count** — `sent` counts people reached, not messages dispatched, and re-sending to a friend who has not signed up yet has not reached anyone new. The address itself is never stored, only a SHA-256 of it: the invitee is not a user and has consented to nothing.\n\nReturns **202, not 200** — the mail is queued, not yet delivered, and a later bounce is not reported here.\n\n**Rate limit: 20 per hour**, tighter than the rest of this router. This is the one endpoint that sends mail on someone else’s behalf, which makes it the one that could be turned into a spam cannon; 20 an hour is generous for a person and useless for a script.',
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
