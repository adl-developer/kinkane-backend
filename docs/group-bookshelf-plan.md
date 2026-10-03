# Group Bookshelf — Implementation Plan

Source: Figma `0eLh4DKXfnYUB6UZQkwLQm`, Production page, section `9/15 Updates`, flows
`Groups / Owner / Currently Reading` `[9386:15201]`, `… / Want to Read` `[9386:15203]`,
`… / Finished Reading` `[9386:17179]`, and the comment screens in
`Groups / Non-Owner View / Public` `[9386:19299]`.

Status: **built 2026-10-02** with the §6 defaults (see `changelog/2026-10-02-group-bookshelf.md`).
Migration 0069 is not yet applied to production.

Group deletion stays **password-confirmed** (current server behaviour), even though the
latest design shows a type-"Delete" box. The client shows a password / re-auth prompt.

---

## 1. What the design shows

**Group page** `[9386:18509]` gains three rows under the description:

| Row | Content |
|---|---|
| Currently reading | One book: cover, title, author, "Started on: Sep 20, 2026", comment count (💬 34). Empty state: "Give your group a book to start reading and begin the conversation!" + `Add a book` (owner). |
| Want to read | Chevron → list. Empty state: "Add books that your group wants to read to let members know what might be the next read." + `Add books` (owner). |
| Finished reading | Chevron → list. |

**Currently Reading (owner)**
1. Search books → pick **one** → `Continue` `[8802:20641 → 9386:13922]`.
2. "Mark as Currently Reading": `Starting on` date (date picker) + `Description` → Save `[9385:10670, 9386:14050]`.
3. Detail screen `[9386:14802]`: book, "Started on", description, comment list,
   `Leave a comment`, and owner actions `Edit book` (change date/description) and
   `Mark as Finished Reading`.

**Finished Reading (owner)** — "Mark as Finished Reading" opens a date picker `[9386:16649]`.
The list `[9386:16895]` shows book, "Finished: Sep 24, 2026", genre tags, "N Books", `Sort`.

**Want to Read (owner)** — search, **multi-select** ("Add 2 books") `[9386:14422]`.
List `[9386:14532]` shows book, genre tags, "N Books", `Sort`, and `Edit books` to remove
`[9386:14972]`.

**Discussion (members)** `[9386:20645, 9386:20696, 9387:21292]`
- Top-level comments on the current book: author, "10h ago", body, ♥ like count,
  💬 reply count, `…` menu.
- Tapping one opens a thread with its replies; replies have ♥ likes but no reply count
  (one level of nesting).
- "Leave a comment" composer.

Not designed: sort options, notifications, what happens to the current book when a new one
is picked. Decisions for those are below.

---

## 2. Data model (migration 0069)

### `group_books` — one row per book per group; shelves are a status

```ts
export const groupBookStatusEnum = pgEnum('group_book_status',
  ['want_to_read', 'currently_reading', 'finished']);

group_books
  id            serial pk
  group_id      int  not null → groups.id   ON DELETE CASCADE
  book_id       int  not null → books.id    ON DELETE CASCADE
  status        group_book_status not null
  description   text null           -- the owner's note on the current read
  started_on    date null           -- calendar day from the picker
  finished_on   date null
  added_by      int  null → users.id ON DELETE SET NULL
  added_at      timestamptz default now()
  updated_at    timestamptz default now()

  UNIQUE (group_id, book_id)                                  -- moving shelves is an UPDATE
  UNIQUE (group_id) WHERE status = 'currently_reading'        -- one current book
  INDEX  (group_id, status, added_at DESC)                    -- list pages
  CHECK  status <> 'currently_reading' OR started_on IS NOT NULL
  CHECK  status <> 'finished' OR finished_on IS NOT NULL
  CHECK  finished_on IS NULL OR started_on IS NULL OR finished_on >= started_on
```

- **`date`, not `timestamptz`**, for started/finished: the picker chooses a day, and a
  timestamp would show the day before for anyone west of UTC.
- **One row per (group, book)** means a book can't be both "want to read" and "finished",
  and picking a want-to-read book as the current read is a status change that keeps its
  `added_at` and history. Trade-off: re-reading a finished book overwrites its old
  `finished_on`. That's acceptable for a book club.
- The partial unique index is the concurrency guard for "one current book". Two owner
  devices racing to set it get a clean 409 instead of two current books.

### `group_book_comments` + `group_book_comment_likes`

```ts
group_book_comments
  id             serial pk
  group_book_id  int not null → group_books.id ON DELETE CASCADE
  user_id        int not null → users.id      ON DELETE CASCADE
  parent_id      int null     → group_book_comments.id ON DELETE CASCADE
  body           text not null
  created_at, updated_at
  INDEX (group_book_id, parent_id, created_at)   -- top-level page and reply page off one index

group_book_comment_likes
  user_id, comment_id   UNIQUE(user_id, comment_id), INDEX(comment_id)
```

- The thread hangs off the `group_books` row, so it **survives the book moving to
  Finished**. It goes away only if the book is removed from the shelf or the group is
  deleted.
- **One level of replies**: the service rejects a `parent_id` whose own `parent_id` is set.
  That's simpler than a CHECK across rows, and matches the design.
- Like and reply counts are aggregated per page with `GROUP BY`, the same as
  `community.service.ts` does for posts and comments. Top-level comments aren't
  denormalised. The 💬 count on the group page is a single `count(*)`.
- These are separate tables, not a reuse of `comments`, which is hard-wired to `post_id`
  NOT NULL. Making it polymorphic would touch every community query for no gain.

---

## 3. Permissions

Extend `ViewerCapabilities` / `groupViewerCapabilities()` so the client reads flags instead
of re-deriving rules:

| Capability | Rule |
|---|---|
| `canSeeShelf` | Same rule as `canSeeMembers`: anyone for a public group, members only for a private one. The private locked screen `[9386:19171]` shows no shelf. |
| `canManageShelf` | Owner only (every shelf flow is under the `Groups / Owner` pill). |
| `canComment` | Owner or active member. Covers posting, replying and liking. |

Comment-level rules: an **author** may edit and delete their own comments. The **group
owner** may delete any comment in the group (moderation). Nobody else can do either.

A removed or departed member's comments stay (same as community posts). Deleting their
account cascades them away.

**Plus gating:** recommend **not** gating group comments or likes, even though community
comments are Plus-only. Joining was left ungated so that a Plus owner's invites are useful
to free friends, and a book club where free members can't talk would undo that.
Creating a group stays Plus-only. *(Confirm.)*

---

## 4. Endpoints (all under `requireAuth`, in `groups.routes.ts`)

### Group detail — extend `GET /groups/:groupId`

```jsonc
{
  "group": { ... },
  "viewer": { ..., "canSeeShelf": true, "canManageShelf": false, "canComment": true },
  "shelf": {                       // null when !canSeeShelf
    "currentlyReading": {          // null → empty state
      "id": 12, "book": { /* BookSummary */ },
      "startedOn": "2026-09-20", "description": "...", "commentCount": 34
    },
    "wantToReadCount": 5,
    "finishedCount": 1
  }
}
```

The counts drive the empty-state copy versus the chevron rows without a second request.

### Shelf

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/groups/:groupId/books?status=want_to_read\|finished&sort=&limit=&offset=` | canSeeShelf | `sort` = `title_asc \| title_desc \| date_asc \| date_desc` (date = `added_at` for want-to-read, `finished_on` for finished), default `date_desc`. These are the same values as `/user-books`, since no sort sheet is designed. Rows include genre tags and `total`. |
| POST | `/groups/:groupId/books` `{ bookIds: number[] }` | owner | Adds to Want to Read. Max 50. Per-book result like invites: `added[]`, `skipped[{bookId, reason: 'already_on_shelf', status}]`. |
| PUT | `/groups/:groupId/books/current` `{ bookId, startedOn, description? }` | owner | Sets the current read. If the book is on Want to Read, it moves (UPDATE); otherwise it's inserted. **409 `current_book_exists`** if another book is current (see §6). |
| PATCH | `/groups/:groupId/books/:groupBookId` `{ startedOn?, description?, finishedOn? }` | owner | The "Edit book" action. Validates the date order. |
| POST | `/groups/:groupId/books/:groupBookId/finish` `{ finishedOn }` | owner | Only from `currently_reading`. Otherwise 409. |
| DELETE | `/groups/:groupId/books/:groupBookId` | owner | The "Edit books" remove action. Also removes the book's discussion (confirm copy on the client). |

Date validation: `YYYY-MM-DD`, not more than a day in the future (to allow for timezones),
and `finishedOn >= startedOn`.

### Discussion

| Method | Path | Who |
|---|---|---|
| GET | `/groups/:groupId/books/:groupBookId/comments?limit&offset` | canSeeShelf. Top-level only, newest first, each with `likeCount`, `replyCount`, `likedByViewer`. |
| GET | `/groups/:groupId/comments/:commentId/replies?limit&offset` | canSeeShelf. Oldest first (reads as a conversation). |
| POST | `/groups/:groupId/books/:groupBookId/comments` `{ body, parentId? }` | canComment. Only on a `currently_reading` book (the only place the design offers "Leave a comment"). Older threads are read-only. |
| PATCH | `/groups/:groupId/comments/:commentId` `{ body }` | author |
| DELETE | `/groups/:groupId/comments/:commentId` | author or group owner |
| POST / DELETE | `/groups/:groupId/comments/:commentId/like` | canComment (unlike is always allowed, same as community) |

Every comment route resolves `commentId → group_book → group` and **checks that it matches
`:groupId`**, so a member of one group can't reach another group's comments by ID.
Body limit: same as community comments. Add a `groupCommentLimiter` alongside
`groupInviteLimiter`.

---

## 5. Build order

1. Schema + migration 0069. Add the columns to `endpoints.contract.test.ts` expectations.
2. Capability flags + unit tests (extend `group-visibility.test.ts`).
3. `group-books.service.ts`: shelf reads/writes, `shelf` block on group detail.
4. Discussion service + likes.
5. Controller/zod schemas, routes, rate limiter.
6. OpenAPI (`src/docs/openapi/paths/groups.ts`) and a "Kinkane Groups Part 3" Postman
   collection.
7. Client brief `docs/group-bookshelf-client-brief.md` with payloads and empty-state rules.

Tests worth having: one-current-book race (two concurrent PUTs → one 409), want→current
move keeps `added_at`, reply-to-reply rejected, cross-group comment ID rejected, private
non-member gets `shelf: null` and 404/403 on the list, and deleting a book removes its
thread.

---

## 6. Open questions (defaults chosen; easy to flip)

1. **Picking a new current book while one is set.** Default: 409, and the owner finishes or
   removes the current one first (the design has no "replace" UI). Alternative: move the
   old one back to Want to Read automatically.
2. **Plus gating on group comments.** Default: not gated (§3).
3. **Reporting a comment** (the `…` menu). Default: file it as a user report against the
   author, plus a new nullable `reported_group_comment_id` (SET NULL), mirroring how
   `postId` works on `user_reports`.
4. **Notifications.** None designed. Candidates for later: "new current read" to members,
   and replies to your comment (`post_comment` pattern). Not in this scope.
