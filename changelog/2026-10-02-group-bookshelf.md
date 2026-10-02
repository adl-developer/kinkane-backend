# Give book clubs a shared bookshelf and a discussion

**Date:** 2026-10-02

## What changed

Each group now has a bookshelf with three shelves: **Currently reading**, **Want to read** and
**Finished reading**. The current book also has a discussion where members can comment, reply and
like. This is the backend for the `Groups / Owner / Currently Reading`, `… / Want to Read` and
`… / Finished Reading` flows in the Figma's "9/15 Updates" section, plus the comment screens in
`Groups / Non-Owner View / Public`.

- **Group page:** `GET /groups/:groupId` now returns a `shelf` block. It holds the current read
  (book, start date, description and comment count) and how many books are on Want to Read and
  Finished. It is `null` when the viewer can't see the shelf.
- **Viewer flags:** the `viewer` block has three new flags: `canSeeShelf`, `canManageShelf` and
  `canComment`.
- **Owner shelf actions:**
  - Add several books to Want to Read at once.
  - Set the current read, with a start date and an optional description.
  - Edit the dates or the description.
  - Mark the current read as finished, with a date.
  - Take a book off the shelf.
- **Members:** comment on the current read, reply one level deep, like comments, and edit or
  delete their own comments. The owner can delete any comment.
- **Reports:** a comment can be reported through the existing reports endpoint (a user report with
  `groupCommentId`). The moderation queue shows the comment's text.

## API

All endpoints are under `/api/v1/groups/:groupId` and require sign-in.

| Method | Path | Who |
|---|---|---|
| GET | `/books?status=&sort=&limit=&offset=` | anyone for public groups, members for private |
| POST | `/books` `{ bookIds }` | owner. Partial success, with `added[]` and `skipped[]` |
| PUT | `/books/current` `{ bookId, startedOn, description? }` | owner |
| GET | `/books/:groupBookId` | as list |
| PATCH | `/books/:groupBookId` `{ startedOn?, finishedOn?, description? }` | owner |
| POST | `/books/:groupBookId/finish` `{ finishedOn }` | owner |
| DELETE | `/books/:groupBookId` | owner (its discussion goes too) |
| GET / POST | `/books/:groupBookId/comments` | read as list; post: members |
| GET | `/comments/:commentId/replies` | as list |
| PATCH / DELETE | `/comments/:commentId` | author; the owner may also delete |
| POST / DELETE | `/comments/:commentId/like` | members like; anyone who can see may unlike |

The full shapes are in the OpenAPI docs (`/docs`, under Groups).

## Data model (migration 0069)

- **`group_books`** has one row per book per group, and its `status` says which shelf the book is
  on. Moving a book between shelves updates that row, so it keeps its history and its discussion.
  The table also has:
  - `started_on` and `finished_on`, stored as `date` rather than a timestamp, because the picker
    chooses a calendar day. A timestamp would show the previous day for anyone west of UTC.
  - A partial unique index that allows **one current book per group**.
  - CHECKs that a current book has a start date, a finished book has a finish date, and the finish
    date isn't before the start date.
- **`group_book_comments`** has a nullable `parent_id`, which allows replies one level deep.
  **`group_book_comment_likes`** holds the likes. Comments are attached to the shelf entry, so
  they survive the book being finished and are deleted when it's removed.
- **`user_reports.group_comment_id`** is nullable and uses SET NULL, the same pattern as `post_id`.

## Decisions worth knowing

- **One current book at a time.** If another book is current, setting a new one returns a 409
  with code `CURRENT_BOOK_EXISTS`. The owner has to finish or remove the current book first. The
  design has no "replace" screen, and quietly moving the current read back to Want to Read would
  hide its live discussion. Two simultaneous requests are settled by the database index (one 200,
  one 409).
- **Moving books between shelves.** A Want to Read book that becomes current keeps its `added_at`.
  Setting a finished book as current again is a re-read, which clears its old finish date.
- **Comments are open only on the current read.** Finished threads stay readable but can't take
  new comments, returning `DISCUSSION_CLOSED`.
- **Group comments don't require Plus**, unlike community comments. Joining is free so that a Plus
  owner's invites work for free friends, and a book club those friends couldn't talk in would undo
  that. Instead, creating a comment is rate limited (60 per 10 minutes per user).
- **The shelf is hidden where the member list is hidden.** A private group's shelf is
  members-only, matching the locked screen in the design, which shows neither.
- **Leaving a private group ends your hold on its discussion.** The owner can delete any comment.
  You can delete your own only while you can still see the shelf, so once you leave or are removed
  from a private group you get a 403 there, the same as on every other read. On a public group
  everyone can see the shelf, so a former member can still delete their own comments, matching
  the rule for taking back a like.
- **Dates can be up to tomorrow (UTC)**, so an owner ahead of UTC can still pick their own today.
- **Group deletion still needs a password or a fresh sign-in.** The newer design shows a
  type-"Delete" box, but the stricter check is kept on purpose.

## Out of scope

- Notifications, such as "new current read" or replies to your comment. None are designed.
- Request-to-join approval.

## How it was verified

- Unit tests in `src/__tests__/group-bookshelf.test.ts` cover the shelf capabilities and every
  state rule (set current, finish, edit, comment and reply, deleting a comment), the date
  window, and the request shapes. The full unit suite passes.
- An end-to-end script ran against a throwaway local Postgres and Redis in Docker, with migration
  0069 applied. It covered every endpoint, the private-group 403s, cross-group ids, the
  concurrent set-current race, `added_at` surviving a move, comments cascading on removal, and a
  report outliving its deleted comment.
