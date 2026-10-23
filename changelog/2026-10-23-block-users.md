# Let users block other users

Apple requires any app with user-generated content to give people a way to
stop others seeing or engaging with them. This adds blocking: a **Block**
option beside **Report** in the "…" menu on a profile and on a community post,
and everything a block has to reach on the server.

## What changed

Three new endpoints, all signed-in:

- `POST /api/v1/users/:userId/block`, body `{ reason?: string }`, returns 201 `{ block }`.
  Safe to repeat: a second call keeps the original block and its reason.
- `DELETE /api/v1/users/:userId/block` unblocks. Only the blocker can do this.
  404 if the caller hasn't blocked them.
- `GET /api/v1/users/blocks?limit&offset` lists the people the caller has
  blocked, newest first, for a Settings → Blocked users screen.

A block is recorded one way but **works both ways**. Neither person:

- sees the other's posts in the community feed, on a book's posts or reviews,
  or in post search. Opening one by id (a stale link) is a 404, the same as a
  deleted post. Liking it or commenting on it is a 404 too.
- sees the other's comments, including old ones and on anyone's post. A post's
  `commentCount` leaves them out, so the number matches the list.
- finds the other in people search or the @-mention typeahead.
- can tag the other. A typed `@handle` stays plain, unlinked text, with no
  mention row and no notification. A mention held back while a post was
  private is never sent if the two have since blocked each other.
- sees the other's old mentions in `GET /user/mentions`.
- can follow the other: 403 with `code: BLOCKED`.
- can open the other's shelf, followers, following or groups (404).

**The profile** becomes the limited version for both people: name, photo and
join date, with no counts and `canViewShelf: false`. Two new fields tell the
app which way the block runs:

- `isBlocked: true` means the caller blocked them. `followStatus` is the new
  value `blocked`, so the button reads "Blocked" and should offer Unblock.
- `hasBlockedYou: true` means they blocked the caller. `followStatus` is
  `none`, and the app should hide Follow.

**In a book club they share**, each still sees what the other writes. The
client asked for this, and a discussion with holes in it wouldn't read. But
neither can reply to or like the other's comments (403 `BLOCKED`). Each group
comment now carries `authorBlocked` so the app can hide those buttons and not
open the author's profile from the comment.

**At the moment of blocking**, these are removed, in one transaction:

- follows and follow requests between the two, both directions
- the notifications each has had about the other (likes, comments, mentions,
  follow accepts, group invites)
- any pending group invitation one has sent the other

None of these return on unblock. Posts, comments and likes are not touched.
They are only hidden from each other while they read, so they reappear when
the block is lifted.

## Data model

New table `user_blocks` (migration `0088_user_blocks`):

| column | type | notes |
|---|---|---|
| blocker_id | integer FK users, cascade | who placed it |
| blocked_id | integer FK users, cascade | who it is against |
| reason | varchar(200), nullable | the app's reason option, if picked |
| created_at | timestamptz | |

The primary key is `(blocker_id, blocked_id)`. There is an index on
`blocked_id` for the reverse lookup, and a CHECK that `blocker_id <> blocked_id`.

## Decisions worth knowing

- **One row per direction, symmetric in effect.** Every filter asks "is there
  a block between these two, either way?" (`blockedBetween` /
  `notBlockedBetween` in `blocks.service.ts`, an `EXISTS` on the primary key and
  the reverse index). Only the profile and the blocked list care who placed it.
  If both people block each other there are two rows, and each has to unblock.
- **No report.** The client's call. Blocking and reporting stay separate
  actions in the menu.
- **The reason is free text, not an enum.** The client hasn't supplied the
  final list. The app sends its option's label; changing the list needs no
  migration. It is optional so that blocking never fails over a skipped choice.
- **A post hidden by a block is a 404, not a 403.** It should look the same as
  a deleted one. Group replies and likes are a 403 with `code: BLOCKED`,
  because the comment is visible there and the person needs to be told why the
  action failed.
- **Group invitations to someone you have a block with** are skipped as
  `not_found`, the same as everywhere else the two look for each other.
- **Unliking stays open.** Taking back your own like on a post you can no
  longer see does no harm, and refusing it would strand the like.

## Out of scope

- Hiding each other from a *third person's* follower or following list, and
  from a group's member list. Tapping through from either opens the limited
  profile.
- Like counts still include likes between the two. There is no likers list to
  hide them from.
- Rate limiting the block endpoint.

## Testing done

- `src/__tests__/user-blocks.integration.test.ts`: 15 tests against a real
  Postgres, each check run from both sides of the block. They cover the
  endpoints, the limited profile, follows, notification cleanup, feed, book
  pages, posts by id, old comments and counts, people and post search, the
  mention typeahead, tagging, the mentions list, shared-group replies and
  likes, and invitations.
- The full unit suite and the full integration suite pass. One unit test that
  asserts the exact SQL of the book-reviews filter was updated for the new
  clause.
