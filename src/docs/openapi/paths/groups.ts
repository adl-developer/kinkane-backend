import {
  json, body, object, param, arrayOf, pagination, authErrors, plusErrors, successResponse,
} from '../helpers';

const GROUPS = 'Groups';

const groupIdParam = param('groupId', 'path', { type: 'integer' }, 'Group id.', { example: 12 });

/**
 * Stated once here and referenced from the operations below, because it is the
 * rule reviewers and client developers most often get backwards: a private
 * group is *unjoinable*, not *secret*.
 */
const PRIVACY_NOTE =
  'A private group is **unjoinable, not secret**. Anyone signed in can see its name, image, description, owner and creation date — that is what the "you need an invite" screen renders. Only the member list and the ability to join are withheld, via the `viewer` block.';

const groupSchema = object({
  id: { type: 'integer', example: 12 },
  name: { type: 'string', example: 'Books & Friends' },
  description: { type: 'string', nullable: true, example: 'A cozy gathering of history enthusiasts.' },
  photoUrl: { type: 'string', nullable: true, example: 'https://res.cloudinary.com/kinkane/image/upload/v1/g.jpg' },
  privacy: { type: 'string', enum: ['public', 'private'], example: 'public' },
  memberCount: { type: 'integer', description: 'Includes the owner.', example: 34 },
  createdAt: { type: 'string', format: 'date-time' },
});

const viewerSchema = object({
  membership: {
    type: 'string',
    enum: ['owner', 'member', 'invited', 'none'],
    description: 'What the caller is to this group.',
    example: 'none',
  },
  canSeeMembers: { type: 'boolean', description: 'False for a non-member of a private group.', example: true },
  canInvite: { type: 'boolean', description: 'True for any member, not only the owner.', example: false },
  canEdit: { type: 'boolean', description: 'Owner only.', example: false },
  canJoin: { type: 'boolean', description: 'Public groups only, and only when not already involved.', example: true },
});

function groupListResponse(description: string) {
  return json(description,
    object({
      groups: arrayOf(groupSchema),
      total: { type: 'integer', example: 7 },
      limit: { type: 'integer', example: 20 },
      offset: { type: 'integer', example: 0 },
    }));
}

export const groupPaths = {
  '/api/v1/groups': {
    post: {
      tags: [GROUPS],
      summary: 'Create a group',
      description:
        'Creates a book club and makes the caller its owner and first member, so `memberCount` starts at 1.\n\n**Requires Kinkané Plus.** Founding a group is the "create durable content others consume" side of the gate, matching post and comment creation. Joining, inviting and browsing are free.\n\nRate limited to 10 per day per user.',
      requestBody: body(object({
        name: { type: 'string', minLength: 1, maxLength: 100, example: 'Books & Friends' },
        description: { type: 'string', maxLength: 2000, nullable: true },
        photoUrl: {
          type: 'string',
          nullable: true,
          description: 'Must already be uploaded to our Cloudinary account; pass the resulting URL.',
        },
        privacy: { type: 'string', enum: ['public', 'private'], default: 'public' },
      }, ['name'])),
      responses: {
        201: json('Created.', object({ group: groupSchema })),
        400: json('Invalid body.', object({ error: { type: 'object' } })),
        ...plusErrors,
      },
    },
    get: {
      tags: [GROUPS],
      summary: 'Browse or search groups',
      description:
        'Without `q`, a discovery list newest first. With `q`, groups matching by name or description, best match first.\n\n' +
        'Matching widens in four tiers — name prefix, word prefix within the name, trigram similarity, then full text across name and description. Full text only joins in from three characters onward. This is deliberately the same formula user and post search use, so results rank consistently wherever they appear side by side.\n\n' +
        'A `q` of only whitespace is treated as a browse rather than matching everything.\n\n' +
        `${PRIVACY_NOTE}`,
      parameters: [
        param('q', 'query', { type: 'string', minLength: 1, maxLength: 200 },
          'Optional search term, matched against name and description.', { example: 'midnight' }),
        ...pagination(50),
      ],
      responses: {
        200: groupListResponse('A page of groups. `q` is echoed back when one was given, so a search response is distinguishable from a browse.'),
        400: json('Invalid query.', object({ error: { type: 'object' } })),
        ...authErrors,
      },
    },
  },

  '/api/v1/groups/mine': {
    get: {
      tags: [GROUPS],
      summary: 'Groups you belong to',
      description: 'Owned and joined groups, most recently joined first. Powers the "Your groups" section of the profile. Pending invitations are not included.',
      parameters: pagination(50),
      responses: { 200: groupListResponse('A page of your groups.'), ...authErrors },
    },
  },

  '/api/v1/groups/{groupId}/members': {
    get: {
      tags: [GROUPS],
      summary: 'Who is in a group',
      description:
        'Oldest first, so the owner — who joins when the group is created — heads the list. Each entry carries `isOwner`.\n\n' +
        'Open to anyone on a public group. On a private group it is **members only**, and a non-member gets **403, not 404**: the group itself is not secret, only its roster. An invitee who has not accepted yet counts as a non-member here.\n\n' +
        '`total` counts memberships directly rather than reading the group\'s stored `memberCount`, so a disagreement between this and the group payload would be the first visible sign of counter drift.',
      parameters: [groupIdParam, ...pagination(50)],
      responses: {
        200: json('A page of members.',
          object({
            members: arrayOf(object({
              id: { type: 'integer', example: 4412 },
              name: { type: 'string', example: 'Theodore Stevens' },
              photoUrl: { type: 'string', nullable: true },
              isOwner: { type: 'boolean', example: false },
              joinedAt: { type: 'string', format: 'date-time', nullable: true },
            })),
            total: { type: 'integer', example: 34 },
            limit: { type: 'integer', example: 20 },
            offset: { type: 'integer', example: 0 },
          })),
        403: json('Private group, and you are not a member.', object({ error: { type: 'string' } })),
        404: json('No such group.', object({ error: { type: 'string' } })),
        ...authErrors,
      },
    },
  },

  '/api/v1/groups/{groupId}/join': {
    post: {
      tags: [GROUPS],
      summary: 'Join a public group',
      description:
        'Public groups only — **no Kinkané Plus needed**. Only *creating* a group is gated; joining one you were pointed at must stay free, or an invitation would be useless to the friend receiving it.\n\n' +
        'Returns the group\'s new member count. Joining twice is a **409**, and concurrent taps settle to a single membership and a single increment — the membership row and the counter move in one transaction, guarded by the unique (group, user) index.\n\n' +
        'An invitee gets a 409 telling them to accept the invitation instead, rather than joining over it and losing who invited them.',
      parameters: [groupIdParam],
      responses: {
        201: json('Joined.', object({
          success: { type: 'boolean', example: true },
          memberCount: { type: 'integer', description: 'The group\'s count after joining.', example: 35 },
        })),
        403: json('The group is private — an invitation is required.', object({ error: { type: 'string' } })),
        404: json('No such group.', object({ error: { type: 'string' } })),
        409: json('Already a member, or already invited.', object({ error: { type: 'string' } })),
        ...authErrors,
      },
    },
  },

  '/api/v1/groups/{groupId}/membership': {
    delete: {
      tags: [GROUPS],
      summary: 'Leave a group',
      description:
        'Removes your own membership and decrements the group\'s count, in one transaction.\n\n' +
        '**The owner cannot leave** — they get a 400 pointing them at deleting the group instead. There is no ownership transfer in this version, so an owner leaving would orphan the group.\n\n' +
        'Someone who was never a member, or who has an unaccepted invitation, gets a 404: declining an invitation is a different action, not a departure.',
      parameters: [groupIdParam],
      responses: {
        200: successResponse,
        400: json('You own this group.', object({ error: { type: 'string' } })),
        404: json('No such group, or you are not a member.', object({ error: { type: 'string' } })),
        ...authErrors,
      },
    },
  },

  '/api/v1/groups/{groupId}': {
    get: {
      tags: [GROUPS],
      summary: 'One group, plus what you may do with it',
      description: `Returns the group and a \`viewer\` block describing the caller's relationship and permissions. The app picks which of the four detail layouts to draw from \`viewer\` rather than re-deriving the privacy rules.\n\n${PRIVACY_NOTE}`,
      parameters: [groupIdParam],
      responses: {
        200: json('The group and the caller’s capabilities.',
          object({ group: groupSchema, viewer: viewerSchema })),
        404: json('No such group.', object({ error: { type: 'string', example: 'Group not found' } })),
        ...authErrors,
      },
    },
    patch: {
      tags: [GROUPS],
      summary: 'Edit a group',
      description:
        'Owner only. Serves both the Edit Group screen and the standalone Privacy Settings screen — the latter sends `privacy` on its own.\n\nAt least one field must be present. A non-owner gets **404, not 403**, so the response cannot be used to confirm that a group exists and belongs to someone else.',
      parameters: [groupIdParam],
      requestBody: body(object({
        name: { type: 'string', minLength: 1, maxLength: 100 },
        description: { type: 'string', maxLength: 2000, nullable: true },
        photoUrl: { type: 'string', nullable: true },
        privacy: { type: 'string', enum: ['public', 'private'] },
      })),
      responses: {
        200: json('Updated.', object({ group: groupSchema })),
        400: json('Invalid body, or no fields given.', object({ error: { type: 'object' } })),
        404: json('No such group, or not yours.', object({ error: { type: 'string' } })),
        ...authErrors,
      },
    },
    delete: {
      tags: [GROUPS],
      summary: 'Delete a group',
      description:
        'Owner only, and permanent — memberships go with it.\n\nThe caller must re-prove who they are, as with deleting an account: send **either** `password` **or** a fresh provider `idToken`. Social-login accounts have no password at all, so the client should offer "Confirm with Google/Apple" and send `idToken` for those. The credential is checked before the group is touched.',
      parameters: [groupIdParam],
      requestBody: body(object({
        password: { type: 'string', description: 'For accounts that have one.' },
        idToken: { type: 'string', description: 'A freshly issued provider token, for social-login accounts.' },
      }), { description: 'Exactly one of `password` or `idToken`.' }),
      responses: {
        200: successResponse,
        400: json('Neither credential supplied.', object({ error: { type: 'object' } })),
        401: json('Wrong password, or a stale sign-in token.', object({ error: { type: 'string' } })),
        404: json('No such group, or not yours.', object({ error: { type: 'string' } })),
        429: { $ref: '#/components/responses/RateLimited' },
        500: { $ref: '#/components/responses/ServerError' },
      },
    },
  },
};
