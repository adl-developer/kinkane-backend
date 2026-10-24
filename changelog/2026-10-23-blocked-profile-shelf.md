# Show people you've blocked as the design does: reader type and shelf, with Unblock

**Date:** 2026-10-23

## What changed

When you open the profile of someone **you** blocked, you now see what any
non-follower sees: their reader type and their shelf (if it's public), with
Unblock in place of Follow. Before, you got the limited profile: name, photo and
join date only.

The other direction is unchanged. If someone has blocked **you**, you still get
the limited profile and nothing past it.

Every profile response also gains `readerType`, the person's quiz result, for
the "<name>'s Reader Type" card. Profiles had no way to show another person's
reader type before.

## Why

The app design for a blocked profile ("Blocked profile when … pressed") shows
the blocked person's reader type and shelf with an Unblock button, and the
client confirmed the build should follow the design. Seeing the profile also
makes it clear who you blocked before you unblock them.

## Data / API shape

- **`GET /users/:userId`:** a new `readerType: string | null`.
  - Null when they haven't taken the quiz, and on the limited profile.
  - When `isBlocked` is true, `canViewShelf` now follows the normal shelf rule
    for a non-follower, where it was always `false` before.
- **`GET /users/:userId/books` and `GET /community/users/:friendId/books/:bookId`:**
  open to the blocker under the normal shelf rule. Still 404 for the person who
  was blocked.

## Non-obvious decisions

- **The blocker is a non-follower.** A block deletes follows both ways, so a
  friends-only shelf stays closed to the blocker, and there are no follower,
  following or post counts. Public shelves open, private ones don't.
- **Reviews still don't cross a block.** Opening one of the blocked person's
  shelf books shows the book but leaves out their review. That keeps the
  existing rule that neither side sees the other's posts anywhere.
- **Followers, following and groups stay closed both ways.** The design shows
  only the shelf tabs, and those lists were never visible to non-followers.
- **No reader type on the limited profile.** The blocked person sees name,
  photo and join date only, as before.

## Out of scope

- Posts, comments, mentions and search across a block are unchanged.
- The app needs to render the reader-type card and shelf on a blocked profile,
  and keep Unblock as the only action besides Report user.

## How it was verified

The blocking integration suite, run against a scratch Postgres:
- The blocker sees `readerType`, `canViewShelf: true`, a 200 shelf, and a shelf
  book without the review.
- The person blocked still gets the limited profile, with `readerType` null and
  404 on the shelf and on a shelf book.
- Followers and groups stay 404 both ways.
- A friends-only shelf stays closed to the blocker.

The typecheck and unit suite pass.
