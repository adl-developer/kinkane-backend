import {
  ref, json, body, object, param, arrayOf, pagination, authErrors, plusErrors, successResponse,
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
  description: { type: 'string', nullable: true, example: 'A cozy gathering of history enthusiasts, run with @kofi.reads.' },
  descriptionMentions: arrayOf(ref('MentionRef'), 'Linked @handles in `description`.'),
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
  canSeeShelf: { type: 'boolean', description: 'The bookshelf and its discussion. Same rule as `canSeeMembers`.', example: true },
  canManageShelf: { type: 'boolean', description: 'Add, move, edit and remove shelf books. Owner only.', example: false },
  canComment: { type: 'boolean', description: 'Post, reply to and like comments. Any member; not Plus-gated.', example: false },
});

// ── Bookshelf ────────────────────────────────────────────────────────────────

const groupBookIdParam = param('groupBookId', 'path', { type: 'integer' },
  'The shelf entry id (`id` on a shelf item) — not the book id.', { example: 88 });
const commentIdParam = param('commentId', 'path', { type: 'integer' }, 'Comment id.', { example: 581 });

const readingDate = (description: string) => ({
  type: 'string', format: 'date', example: '2026-09-20',
  description: `${description} A calendar day, \`YYYY-MM-DD\`, no later than tomorrow (UTC) so an owner ahead of UTC can still pick their own today.`,
});

const bookCardSchema = object({
  id: { type: 'integer', example: 50211 },
  isbn13: { type: 'string', nullable: true, example: '9780008521837' },
  title: { type: 'string', example: 'Land' },
  subtitle: { type: 'string', nullable: true },
  coverUrl: { type: 'string', nullable: true },
  authors: arrayOf({ type: 'string', example: 'Maggie O’Farrell' }, 'A01 contributors; the first listed contributor when there are none.'),
  genres: arrayOf(object({ name: { type: 'string', example: 'Fiction' }, slug: { type: 'string', example: 'fiction' } }),
    'Top-level display genres — the chips on the shelf rows.'),
});

const shelfItemSchema = object({
  id: { type: 'integer', description: 'Shelf entry id — what edit, finish, remove and comment routes take.', example: 88 },
  status: { type: 'string', enum: ['want_to_read', 'currently_reading', 'finished'], example: 'currently_reading' },
  book: bookCardSchema,
  description: { type: 'string', nullable: true, description: "The owner's note on the read. May contain @mentions." },
  descriptionMentions: arrayOf(ref('MentionRef'), 'Linked @handles in `description`.'),
  startedOn: { type: 'string', format: 'date', nullable: true, example: '2026-09-20' },
  finishedOn: { type: 'string', format: 'date', nullable: true, example: null },
  addedAt: { type: 'string', format: 'date-time' },
  commentCount: { type: 'integer', description: 'All comments and replies — the 💬 count.', example: 34 },
});

const shelfSummarySchema = {
  ...object({
    currentlyReading: { ...shelfItemSchema, nullable: true, description: 'Null → the "Give your group a book to start reading" empty state.' },
    wantToReadCount: { type: 'integer', description: '0 → the "Add books that your group wants to read" empty state.', example: 5 },
    finishedCount: { type: 'integer', example: 1 },
  }),
  nullable: true,
  description: 'Null when the caller may not see the shelf (a private group they are not in) — distinct from an empty shelf.',
};

const commentSchema = object({
  id: { type: 'integer', example: 581 },
  groupBookId: { type: 'integer', example: 88 },
  parentId: { type: 'integer', nullable: true, description: 'Null on a top-level comment.', example: null },
  userId: { type: 'integer', example: 4412 },
  userName: { type: 'string', example: 'Amara Okafor' },
  userUsername: { type: 'string', nullable: true, example: 'amara.o' },
  userPhotoUrl: { type: 'string', nullable: true },
  body: { type: 'string', example: 'Love this book! @kofi.reads, chapter 3?' },
  mentions: arrayOf(ref('MentionRef'), 'Linked @handles in `body`.'),
  likeCount: { type: 'integer', example: 1 },
  replyCount: { type: 'integer', description: 'Always 0 on a reply — replies cannot be replied to.', example: 2 },
  likedByMe: { type: 'boolean', example: false },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
});

const shelfErrors = {
  403: json('Private group and not a member (reads), not the owner (shelf writes), or not a member (comment writes).',
    object({ error: { type: 'string' } })),
  404: json('No such group, or that entry/comment is not in this group.', object({ error: { type: 'string' } })),
  ...authErrors,
};

const conflict = (codes: string) =>
  json(`State conflict. \`code\` is one of ${codes}.`, object({ error: { type: 'string' }, code: { type: 'string' } }));

const commentPage = (description: string) => json(description, object({
  comments: arrayOf(commentSchema),
  total: { type: 'integer', example: 2 },
  limit: { type: 'integer', example: 20 },
  offset: { type: 'integer', example: 0 },
}));

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

  '/api/v1/users/{userId}/groups': {
    get: {
      tags: [GROUPS],
      summary: "Groups someone else belongs to",
      description:
        'The "Groups" section of another reader\'s profile, most recently joined first. The same shape as `/api/v1/groups/mine`, and pending invitations are excluded here too.\n\n' +
        '**Filtered to what you may see.** Public groups always appear. A private group appears only if *you* are an active member of it as well — otherwise reading profiles one by one would rebuild the roster of every private group, which `GET /groups/{groupId}/members` deliberately refuses. So this endpoint never reveals a membership the member list would not.\n\n' +
        '`total` counts the filtered set, so it matches what can actually be paged through — two people looking at the same profile can legitimately see different totals.\n\n' +
        'Calling it with your own id is allowed and returns everything, identical to `/api/v1/groups/mine`.',
      parameters: [
        param('userId', 'path', { type: 'integer' }, 'The user whose groups to list.', { example: 4412 }),
        ...pagination(50),
      ],
      responses: {
        200: groupListResponse("A page of that reader's groups."),
        400: json('Invalid user id.', object({ error: { type: 'string' } })),
        404: json('No such user.', object({ error: { type: 'string' } })),
        ...authErrors,
      },
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

  '/api/v1/groups/{groupId}/invitable-friends': {
    get: {
      tags: [GROUPS],
      summary: 'Friends you could still invite',
      description:
        'Backs the friend picker. Returns the caller\'s friends **minus anyone who already has a membership or a pending invitation** for this group — a checkbox next to someone who joined ten minutes ago is a guaranteed rejection on submit.\n\n' +
        '"Friend" means an accepted follow in **either** direction, matching the friend count on a profile. Optional `q` narrows by name, on a prefix or word prefix only — this filters a list the caller already knows, so it does not fuzzy-match the way group discovery does.\n\n' +
        'Members only, including the owner. An invitee who has not accepted gets a 403.',
      parameters: [
        groupIdParam,
        param('q', 'query', { type: 'string', minLength: 1, maxLength: 200 }, 'Narrow by name.', { example: 'theo' }),
        ...pagination(50),
      ],
      responses: {
        200: json('A page of invitable friends.',
          object({
            friends: arrayOf(object({
              id: { type: 'integer', example: 4412 },
              name: { type: 'string', example: 'Theodore Stevens' },
              photoUrl: { type: 'string', nullable: true },
            })),
            total: { type: 'integer', example: 12 },
            limit: { type: 'integer', example: 20 },
            offset: { type: 'integer', example: 0 },
          })),
        403: json('You are not a member of this group.', object({ error: { type: 'string' } })),
        404: json('No such group.', object({ error: { type: 'string' } })),
        ...authErrors,
      },
    },
  },

  '/api/v1/groups/{groupId}/invites': {
    post: {
      tags: [GROUPS],
      summary: 'Invite people to a group',
      description:
        '**Any member can invite, not only the owner** — the design puts "+ Invite friends" on the plain-member view, and a private group would otherwise depend entirely on its owner to grow. An invitee who has not accepted yet cannot invite onward.\n\n' +
        '**Partial success by design.** Ids that cannot be invited come back in `skipped` with a reason rather than failing the batch — the picker may offer three people and one of them may have joined in between. A request where *every* id is skipped is still a 201: it was understood and acted on.\n\n' +
        '**Anyone on the app can be invited**, not only friends. The invitable-friends list is just the picker\'s suggestion; this endpoint accepts any user id.\n\n' +
        'Skip reasons: `self`, `not_found` (no account with that id), `already_member`, `already_invited`.\n\n' +
        'Rate limited to 30 **requests** per hour, and a single request carries at most 50 ids. Together those are the ceiling.',
      parameters: [groupIdParam],
      requestBody: body(object({
        userIds: {
          type: 'array',
          items: { type: 'integer' },
          minItems: 1,
          maxItems: 50,
          example: [4412, 4413, 4414],
        },
      }, ['userIds'])),
      responses: {
        201: json('Processed. Check `skipped` — this is a 201 even if nothing was invited.',
          object({
            invited: arrayOf({ type: 'integer' }, 'Ids genuinely invited by this request.'),
            skipped: arrayOf(object({
              userId: { type: 'integer', example: 4415 },
              reason: { type: 'string', enum: ['self', 'not_found', 'already_member', 'already_invited'] },
            })),
          })),
        400: json('Invalid body.', object({ error: { type: 'object' } })),
        403: json('You are not a member of this group.', object({ error: { type: 'string' } })),
        404: json('No such group.', object({ error: { type: 'string' } })),
        ...authErrors,
      },
    },
  },

  '/api/v1/groups/{groupId}/invites/accept': {
    post: {
      tags: [GROUPS],
      summary: 'Accept an invitation',
      description:
        'Turns your invitation into membership and returns the group\'s new member count. This is how anyone joins a private group.\n\n' +
        'Accepting twice is a **404**, as is accepting with no invitation — the response deliberately does not distinguish "never invited" from "already handled", so it cannot be used to discover whether an invitation once existed.',
      parameters: [groupIdParam],
      responses: {
        200: json('Joined.', object({
          success: { type: 'boolean', example: true },
          memberCount: { type: 'integer', example: 35 },
        })),
        404: json('No such group, or no invitation outstanding.', object({ error: { type: 'string' } })),
        ...authErrors,
      },
    },
  },

  '/api/v1/groups/{groupId}/invites/decline': {
    post: {
      tags: [GROUPS],
      summary: 'Decline an invitation',
      description:
        'Removes the invitation. The member count does not move — an invitation was never counted.\n\n' +
        'Declining **deletes** the invitation rather than marking it declined, which is a deliberate difference from follow requests. Nothing in the design reads a declined state, and keeping the row would make every future re-invitation an update rather than a plain insert. **You can therefore be re-invited after declining**; the invite rate limit is what stops that becoming a nuisance.',
      parameters: [groupIdParam],
      responses: {
        200: successResponse,
        404: json('No such group, or no invitation outstanding.', object({ error: { type: 'string' } })),
        ...authErrors,
      },
    },
  },

  '/api/v1/groups/{groupId}/members/{userId}': {
    delete: {
      tags: [GROUPS],
      summary: 'Remove someone from a group',
      description:
        'Owner only. Covers **both** removing a member and withdrawing a pending invitation — the owner is severing the same link either way, and the count only moves if the row was an actual membership.\n\n' +
        '**This never touches the follow graph.** Group membership is independent of following, so removing someone must not unfollow them, whatever the confirmation dialog says.\n\n' +
        'A non-owner gets **404, not 403**, because ownership is part of the lookup. The owner cannot remove themselves — that is a 400 pointing at deleting the group.',
      parameters: [
        groupIdParam,
        param('userId', 'path', { type: 'integer' }, 'The person to remove.', { example: 4412 }),
      ],
      responses: {
        200: successResponse,
        400: json('You cannot remove yourself as owner.', object({ error: { type: 'string' } })),
        404: json('No such group, not yours, or that person is not in it.', object({ error: { type: 'string' } })),
        ...authErrors,
      },
    },
  },

  '/api/v1/groups/{groupId}': {
    get: {
      tags: [GROUPS],
      summary: 'One group, plus what you may do with it',
      description: `Returns the group and a \`viewer\` block describing the caller's relationship and permissions. The app picks which of the four detail layouts to draw from \`viewer\` rather than re-deriving the privacy rules.\n\nAlso carries a \`shelf\` block — the current read and the Want to Read / Finished counts — so the group page draws in one request.\n\n${PRIVACY_NOTE}`,
      parameters: [groupIdParam],
      responses: {
        200: json('The group and the caller’s capabilities.',
          object({ group: groupSchema, viewer: viewerSchema, shelf: shelfSummarySchema })),
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

  '/api/v1/groups/{groupId}/books': {
    get: {
      tags: [GROUPS],
      summary: 'One shelf of a group',
      description:
        'A page of one shelf. `sort` takes the same four values as `/user-books`; "date" means when the book was **finished** on the Finished shelf and when it was **added** everywhere else.\n\n' +
        'Readable by anyone for a public group and by members for a private one (`viewer.canSeeShelf`).',
      parameters: [
        groupIdParam,
        param('status', 'query', { type: 'string', enum: ['want_to_read', 'currently_reading', 'finished'] }, 'Which shelf.', { required: true, example: 'want_to_read' }),
        param('sort', 'query', { type: 'string', enum: ['title_asc', 'title_desc', 'date_asc', 'date_desc'], default: 'date_desc' }, 'Order.'),
        ...pagination(50),
      ],
      responses: {
        200: json('A page of the shelf.', object({
          books: arrayOf(shelfItemSchema),
          total: { type: 'integer', example: 5 },
          status: { type: 'string' }, sort: { type: 'string' },
          limit: { type: 'integer' }, offset: { type: 'integer' },
        })),
        400: json('Invalid query.', object({ error: { type: 'object' } })),
        ...shelfErrors,
      },
    },
    post: {
      tags: [GROUPS],
      summary: 'Add books to Want to Read',
      description:
        'Owner only. The multi-select picker ("Add 2 books"). Up to 50 ids.\n\n' +
        '**Partial success**, like invitations: each id that could not be added comes back in `skipped` with a reason — `not_found` (no such book, or a title delisted from the catalogue), or `already_on_shelf` with the shelf it is on — and the rest are added. 201 even if everything was skipped.',
      parameters: [groupIdParam],
      requestBody: body(object({ bookIds: arrayOf({ type: 'integer', minimum: 1 }) }, ['bookIds'])),
      responses: {
        201: json('Added (possibly partially).', object({
          added: arrayOf(object({ id: { type: 'integer', example: 89 }, bookId: { type: 'integer', example: 50211 } })),
          skipped: arrayOf(object({
            bookId: { type: 'integer' },
            reason: { type: 'string', enum: ['not_found', 'already_on_shelf'] },
            status: { type: 'string', enum: ['want_to_read', 'currently_reading', 'finished'], description: 'Present for already_on_shelf.' },
          })),
        })),
        400: json('Invalid body.', object({ error: { type: 'object' } })),
        ...shelfErrors,
      },
    },
  },

  '/api/v1/groups/{groupId}/books/current': {
    put: {
      tags: [GROUPS],
      summary: 'Set the current read',
      description:
        'Owner only. "Mark as Currently Reading": a book, the start date and an optional description.\n\n' +
        'A book already on Want to Read **moves** (keeping when it was added); one on Finished becomes a **re-read** and its finish date is cleared; anything else is added.\n\n' +
        '**One current book per group.** If another book is current this is a 409 `CURRENT_BOOK_EXISTS` — mark it finished or remove it first. The design has no "replace" screen, so the server never demotes the current read on its own.',
      parameters: [groupIdParam],
      requestBody: body(object({
        bookId: { type: 'integer', minimum: 1, example: 50211 },
        startedOn: readingDate('Start date.'),
        description: { type: 'string', maxLength: 2000, nullable: true },
      }, ['bookId', 'startedOn'])),
      responses: {
        200: json('The new current read.', object({ book: shelfItemSchema })),
        400: json('Invalid body or date.', object({ error: { type: 'object' } })),
        409: conflict('`CURRENT_BOOK_EXISTS`, `ALREADY_CURRENT`'),
        ...shelfErrors,
      },
    },
  },

  '/api/v1/groups/{groupId}/books/{groupBookId}': {
    get: {
      tags: [GROUPS],
      summary: 'One shelf entry',
      description: 'The Currently Reading screen: book, dates, description and comment count.',
      parameters: [groupIdParam, groupBookIdParam],
      responses: { 200: json('The entry.', object({ book: shelfItemSchema })), ...shelfErrors },
    },
    patch: {
      tags: [GROUPS],
      summary: 'Edit a shelf entry',
      description:
        'Owner only. "Edit book": change the start date, the finish date (finished books only) or the description. At least one field.\n\n' +
        'Want to Read entries have nothing to edit — 409 `NOT_EDITABLE`. The finish date can never end up before the start date.',
      parameters: [groupIdParam, groupBookIdParam],
      requestBody: body(object({
        startedOn: readingDate('New start date.'),
        finishedOn: readingDate('New finish date. Finished books only.'),
        description: { type: 'string', maxLength: 2000, nullable: true },
      })),
      responses: {
        200: json('Updated.', object({ book: shelfItemSchema })),
        400: json('Invalid body, a finish date on an unfinished book, or dates out of order.', object({ error: { type: 'object' } })),
        409: conflict('`NOT_EDITABLE`'),
        ...shelfErrors,
      },
    },
    delete: {
      tags: [GROUPS],
      summary: 'Remove a book from the shelf',
      description: 'Owner only. Works on any shelf, including the current read. **Its discussion is deleted with it** — confirm in the client.',
      parameters: [groupIdParam, groupBookIdParam],
      responses: { 200: successResponse, ...shelfErrors },
    },
  },

  '/api/v1/groups/{groupId}/books/{groupBookId}/finish': {
    post: {
      tags: [GROUPS],
      summary: 'Mark the current read as finished',
      description: 'Owner only. Moves the current read to Finished with the picked date. Its discussion stays readable but closes to new comments.',
      parameters: [groupIdParam, groupBookIdParam],
      requestBody: body(object({ finishedOn: readingDate('Finish date; not before the start date.') }, ['finishedOn'])),
      responses: {
        200: json('Now on Finished.', object({ book: shelfItemSchema })),
        400: json('Invalid date, or before the start date.', object({ error: { type: 'object' } })),
        409: conflict('`NOT_CURRENT`'),
        ...shelfErrors,
      },
    },
  },

  '/api/v1/groups/{groupId}/books/{groupBookId}/comments': {
    get: {
      tags: [GROUPS],
      summary: 'Comments on a shelf book',
      description: 'Top-level comments, newest first, each with `likeCount`, `replyCount` and `likedByMe`. Fetch a thread with `/comments/{commentId}/replies`.',
      parameters: [groupIdParam, groupBookIdParam, ...pagination(50)],
      responses: { 200: commentPage('A page of top-level comments.'), ...shelfErrors },
    },
    post: {
      tags: [GROUPS],
      summary: 'Comment, or reply to a comment',
      description:
        'Members only (`viewer.canComment`); **not** Plus-gated.\n\n' +
        'Only the **current read** takes new comments — elsewhere it is 409 `DISCUSSION_CLOSED`. Pass `parentId` to reply; replies are one level deep, so `parentId` must be a top-level comment on the same book.\n\n' +
        'Rate limited to 60 per 10 minutes per user.',
      parameters: [groupIdParam, groupBookIdParam],
      requestBody: body(object({
        body: { type: 'string', minLength: 1, maxLength: 2000 },
        parentId: { type: 'integer', minimum: 1, description: 'Reply to this top-level comment.' },
      }, ['body'])),
      responses: {
        201: json('Created.', object({ comment: commentSchema })),
        400: json('Invalid body, or a reply to a reply / to a comment on another book.', object({ error: { type: 'object' } })),
        409: conflict('`DISCUSSION_CLOSED`'),
        ...shelfErrors,
      },
    },
  },

  '/api/v1/groups/{groupId}/comments/{commentId}/replies': {
    get: {
      tags: [GROUPS],
      summary: 'Replies to a comment',
      description: 'Oldest first, so the thread reads as a conversation. 400 if `commentId` is itself a reply.',
      parameters: [groupIdParam, commentIdParam, ...pagination(50)],
      responses: { 200: commentPage('A page of replies.'), ...shelfErrors },
    },
  },

  '/api/v1/groups/{groupId}/comments/{commentId}': {
    patch: {
      tags: [GROUPS],
      summary: 'Edit your comment',
      description: 'Author only, and only while still a member. Someone else’s comment is a 404.',
      parameters: [groupIdParam, commentIdParam],
      requestBody: body(object({ body: { type: 'string', minLength: 1, maxLength: 2000 } }, ['body'])),
      responses: { 200: successResponse, 400: json('Invalid body.', object({ error: { type: 'object' } })), ...shelfErrors },
    },
    delete: {
      tags: [GROUPS],
      summary: 'Delete a comment',
      description:
        'The group owner may delete any comment (moderation). The author may delete their own only while they can still see the shelf: on a private group, someone who has left or been removed gets a 403 (the same as every other read), while a former member of a public group can still delete theirs. Anyone else who can see the shelf gets a 404 for a comment that is not theirs. Deleting a top-level comment deletes its replies.',
      parameters: [groupIdParam, commentIdParam],
      responses: { 200: successResponse, ...shelfErrors },
    },
  },

  '/api/v1/groups/{groupId}/comments/{commentId}/like': {
    post: {
      tags: [GROUPS],
      summary: 'Like a comment',
      description: 'Members only. Idempotent.',
      parameters: [groupIdParam, commentIdParam],
      responses: { 200: successResponse, ...shelfErrors },
    },
    delete: {
      tags: [GROUPS],
      summary: 'Unlike a comment',
      description: 'Anyone who can see the shelf may take back their own like. Idempotent.',
      parameters: [groupIdParam, commentIdParam],
      responses: { 200: successResponse, ...shelfErrors },
    },
  },
};
