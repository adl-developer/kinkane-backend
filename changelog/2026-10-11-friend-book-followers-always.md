# Followers can always open a friend's book page, whatever their shelf setting

## What changed

`GET /community/users/:friendId/books/:bookId` (one book from someone's shelf) now always lets
**accepted followers** in, even when the shelf is set to `private`. Everyone else still goes by the
shelf setting:

| Shelf setting | Full shelf (`GET /users/:userId/books`) | One book (this page) |
| --- | --- | --- |
| `public` | everyone | everyone |
| `friends` | owner and accepted followers | owner and accepted followers |
| `private` | owner only | owner **and accepted followers** |

The full shelf is unchanged, and so is `canViewShelf` on the profile, which still describes the full
shelf. So an accepted follower of someone with a private shelf sees `canViewShelf: false`, gets 404 on
the shelf tab, and can still open a single book from a post or link.

Private reviews stay author-only. A follower who opens a book from a private shelf sees the book,
the owner's public note and a public review, but never a private review.

## Why

The change on 2026-10-10 (see `2026-10-10-friend-book-shelf-privacy.md`) made the book page follow
the shelf setting exactly. That closed the page to accepted followers whenever the owner's shelf was
private, and the page had always been open to them before. The product decision is that one book
reveals far less than the whole list, so people you've accepted as followers keep it. Strangers on a
public shelf are unaffected.

## Decisions

- **Two rules, side by side.** `canViewShelf` (whole shelf) and `canViewShelfBook` (one book) sit
  next to each other in `users.service.ts`. The book rule is defined as "accepted follower, or
  whatever the shelf rule says", so a change to the shelf rule carries over automatically.
- **One query for "who is this person to me".** The shelf checks, the follower-list check and the
  profile used to fetch the user and the follow request in separate queries, in three slightly
  different copies. They now share one `LEFT JOIN` (`loadViewerRelationship`). That's one round-trip
  where there were two, and the three can no longer disagree about what counts as following.
- **Still 404, not 403**, when the page is closed, so it can't be used to check whether an account
  exists.

## Out of scope

- A profile flag for "can open single books". The app can tell from `followStatus === 'accepted'`
  or `shelfVisibility === 'public'`. Add one if the app ends up needing it.

## How it was verified

- New unit tests cover `canViewShelfBook`. The integration suite now checks that an accepted
  follower can open a book from a private shelf while someone with a pending request and a stranger
  can't, and that the follower still doesn't see a private review there.
- With the page switched back to the whole-shelf rule, those integration tests fail.
- The full integration suite (88 tests) was run against a scratch Postgres. The unit suite (1373
  tests) and the type check pass, and the documented response bodies still match live responses.
