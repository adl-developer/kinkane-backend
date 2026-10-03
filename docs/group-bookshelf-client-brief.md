# Group bookshelf & discussion — mobile client brief

**Audience:** whoever builds the book-club bookshelf and its comment screens in the Groups flows
(Figma, "9/15 Updates": `Groups / Owner / Currently Reading`, `… / Want to Read`,
`… / Finished Reading`, and the comment screens in `Groups / Non-Owner View / Public`).
**Status:** pushed on `feat/group-bookshelf`, not merged or deployed. It needs **migration 0069**
on the target database. Until that migration runs, the group page, every bookshelf endpoint and
report filing return 500.

This document stands on its own. The field-by-field contracts are in the OpenAPI spec at
`GET /openapi.json` (Swagger UI on the same host), under **Groups**. **If this document and the
spec disagree, the spec is correct**, because it's generated from the running code. There's also a
Postman collection, "Kinkane Groups (Part 2)", whose folders 6–8 run the whole flow in order.

---

## 1. What you are building

Every club has three shelves and a discussion.

```
Group page ─┬─ Currently reading (one book) ──► book screen ──► comments ──► replies
            ├─ Want to read (list)          ──► full list (Sort · Edit books)
            └─ Finished reading (list)      ──► full list (Sort)
```

- **The owner manages the shelves:**
  - add books to Want to read
  - set the current read
  - edit its dates or description
  - mark it finished
  - remove books
- **Members talk about the current read:** comment, reply and like.
- **Anyone who can see the club can read it:**
  - for a public club, that's anyone signed in
  - for a private club, only members

Every endpoint needs a signed-in user (`Authorization: Bearer <access token>`).
**Kinkané Plus isn't required** for any of it. The only Plus-gated part of Groups is creating a
club, which is unchanged.

---

## 2. The group page: `GET /api/v1/groups/{groupId}`

You already call this endpoint. It now returns three new `viewer` flags and a new `shelf` block.

```jsonc
{
  "group":  { "id": 4, "name": "Books & Friends", "memberCount": 34, "privacy": "public", "owner": { … }, … },
  "viewer": {
    "membership": "member",     // owner | member | invited | none
    "canSeeMembers": true,
    "canInvite": true,
    "canEdit": false,
    "canJoin": false,
    "canSeeShelf": true,        // NEW: the three shelf rows exist at all
    "canManageShelf": false,    // NEW: owner only, the "Add a book" / "Add books" / "Edit" actions
    "canComment": true          // NEW: members, "Leave a comment", reply, like
  },
  "shelf": {                    // NEW: null when canSeeShelf is false
    "currentlyReading": { /* shelf item, see §3, or null */ },
    "wantToReadCount": 5,
    "finishedCount": 1
  }
}
```

**Draw from the flags. Don't re-derive the rules** from `privacy` and `membership`.

| Flag | What it controls |
|---|---|
| `canSeeShelf` | Whether to draw the Currently reading, Want to read and Finished reading sections at all. |
| `canManageShelf` | "Add a book", "Add books", "Edit book", "Mark as Finished Reading", "Edit books", and moving a book between shelves. **Hide these when it's false**, even where a Figma frame shows them to a non-owner (e.g. `9386:16758`). The server refuses them with 403. |
| `canComment` | "Leave a comment", replying and liking. |

**Empty states**

| Condition | Show |
|---|---|
| `shelf === null` | No shelf sections at all. This is the private-club locked state. |
| `shelf.currentlyReading === null` | "Give your group a book to start reading and begin the conversation!" Show "Add a book" only if `canManageShelf`. |
| `shelf.wantToReadCount === 0` | "Add books that your group wants to read…" Show "Add books" only if `canManageShelf`. |
| `shelf.finishedCount === 0` | Hide the Finished reading section, as the owner's empty-club frame does. |

`null` means "you can't see this"; an empty shelf means "nothing here yet". Keep them visually
distinct.

> **Covers on the group page.** The response gives counts, not the books, for Want to read and
> Finished. To draw those cover strips, call the list endpoint (§4) for each shelf. Changing the
> group response to include the books themselves is under discussion. If it changes, this brief
> will be updated.

---

## 3. The shelf item

Every endpoint that returns a book on a shelf uses this shape:

```jsonc
{
  "id": 88,                          // SHELF ENTRY id: not the book id
  "status": "currently_reading",     // want_to_read | currently_reading | finished
  "book": {
    "id": 50211,                     // catalogue book id: use it to open the normal book detail page
    "isbn13": "9780008521837",
    "title": "Land",
    "subtitle": null,
    "coverUrl": "https://…",
    "authors": ["Maggie O’Farrell"], // may be [] for a book with no listed contributors
    "genres": [{ "name": "Fiction", "slug": "fiction" }]  // the chips on list rows
  },
  "description": "Our first read together.",   // owner's note; null if none
  "startedOn": "2026-09-20",         // calendar date, or null
  "finishedOn": null,                // calendar date, or null
  "addedAt": "2026-10-02T08:00:00.000Z",
  "commentCount": 34                 // all comments + replies: the 💬 number
}
```

Two things trip people up:

1. **`id` is the shelf entry, not the book.** Every shelf and comment route takes the entry `id`.
   Use `book.id` only to open the existing book detail page (the "Book Detail" arrow from the
   current read). The entry `id` stays the same when a book moves from Want to read to Currently
   reading, or from Currently reading to Finished.
2. **`startedOn` and `finishedOn` are calendar dates (`YYYY-MM-DD`), not timestamps.** Display
   them as they are ("Started on: Sep 20, 2026"). **Don't convert them through a timezone**, or
   readers west of UTC will see the previous day. Send them in the same `YYYY-MM-DD` form.

---

## 4. Shelf endpoints

All paths are under `/api/v1/groups/{groupId}`.

### Read a shelf: `GET /books?status=…`

The full-screen Want to read and Finished reading lists. Also use this for the group-page cover
strips.

| Query | Values | Default |
|---|---|---|
| `status` | `want_to_read` \| `currently_reading` \| `finished` | **required** |
| `sort` | `title_asc` \| `title_desc` \| `date_asc` \| `date_desc` | `date_desc` |
| `limit` / `offset` | 1–50 / ≥0 | 20 / 0 |

- **What "date" sorts by:** when the book was **added** on Want to read, and when it was
  **finished** on Finished. The four sort values match the personal shelf's (`/user-books`).
  The Figma has no sort sheet, so reuse the personal shelf's.
- **The list/shelf layout toggle** is purely client-side; the data is the same.

Response: `{ books: [ShelfItem], total, status, sort, limit, offset }`. Use `total` for "5 Books".

### Open one entry: `GET /books/{groupBookId}`

The Currently Reading screen: cover, title, "Started on", description. Returns `{ book: ShelfItem }`.

### Add to Want to read (owner): `POST /books`

```json
{ "bookIds": [50213, 50214] }
```

Backs the multi-select picker ("Add 2 books"); up to 50 ids. Use the existing book search for
the picker's search box.

**This can partly succeed.** The response is always 201:

```json
{
  "added":   [{ "id": 91, "bookId": 50213 }],
  "skipped": [{ "bookId": 50214, "reason": "already_on_shelf", "status": "finished" }]
}
```

`reason` is `not_found` (no such book, or a title withdrawn from the catalogue) or
`already_on_shelf`, which comes with the `status` of the shelf it's already on. Show the added
books and, if anything was skipped, a short note. Don't treat a 201 with skips as a failure.

### Set the current read (owner): `PUT /books/current`

```json
{ "bookId": 50211, "startedOn": "2026-09-20", "description": "Optional, up to 2000 chars" }
```

This is the "Mark as Currently Reading" sheet. `startedOn` is required.

- **Where the book comes from:**
  - from Want to read: it **moves**, keeping the same entry `id`
  - from Finished: a **re-read**, which clears its finish date and **reopens its old
    discussion**
  - not on the shelf yet: it's added
- **Only one current read per club.** If another book is current you get **409 with
  `code: "CURRENT_BOOK_EXISTS"`**. The server never swaps books for you. Tell the owner to mark
  the current one finished (or remove it) first. `code: "ALREADY_CURRENT"` means this exact book
  is already current.
- **Date limit:** `startedOn` can't be later than tomorrow (UTC), so an owner ahead of UTC can
  still pick their own today. A future date is a 400. Limit the date picker the same way.

Returns `{ book: ShelfItem }`.

### Edit (owner): `PATCH /books/{groupBookId}`

"Edit book". Send any of `startedOn`, `description` (send `null` to clear it), and, on a
**finished** book only, `finishedOn`. At least one field is required.

- **Want to read entries** have nothing to edit: **409 `NOT_EDITABLE`**. Don't offer Edit on them.
- **Dates must stay in order.** The finish date can't end up before the start date (400).

### Mark as finished (owner): `POST /books/{groupBookId}/finish`

```json
{ "finishedOn": "2026-09-24" }
```

Only works on the current read (otherwise **409 `NOT_CURRENT`**), and not before its start date
(400). The club then has no current read, so the group page goes back to the "Give your group a
book…" empty state.

### Remove (owner): `DELETE /books/{groupBookId}`

"Edit books" → ✕. It works on any shelf, including the current read. **The book's discussion is
deleted with it**, so confirm with the owner before removing a book that has comments
(`commentCount > 0`). There's no batch delete; send one request per book.

---

## 5. Discussion endpoints

All paths are under `/api/v1/groups/{groupId}`.

| Action | Request | Who |
|---|---|---|
| Top-level comments | `GET /books/{groupBookId}/comments?limit&offset` | anyone with `canSeeShelf` |
| Replies to a comment | `GET /comments/{commentId}/replies?limit&offset` | anyone with `canSeeShelf` |
| Post a comment | `POST /books/{groupBookId}/comments` `{ "body": "…" }` | `canComment` |
| Reply | the same POST with `"parentId": {commentId}` | `canComment` |
| Edit your comment | `PATCH /comments/{commentId}` `{ "body": "…" }` | the author, while still a member |
| Delete a comment | `DELETE /comments/{commentId}` | the author, or the club owner |
| Like / unlike | `POST` / `DELETE /comments/{commentId}/like` | `canComment` (unlike: `canSeeShelf`) |

The comment shape:

```jsonc
{
  "id": 581,
  "groupBookId": 88,
  "parentId": null,            // null = top-level; otherwise the comment it replies to
  "userId": 4412,
  "userName": "Amara Okafor",
  "userPhotoUrl": "https://…",
  "body": "Love this book! Would love to discuss it.",
  "likeCount": 1,
  "replyCount": 2,             // always 0 on a reply
  "likedByMe": false,
  "createdAt": "…",            // relative time ("10h ago") from this
  "updatedAt": "…"
}
```

**Rules to build around**

- **Comments are open only on the current read.** Posting on a Want to read or Finished book
  returns **409 `DISCUSSION_CLOSED`**. Finished books' threads stay **readable**; show them
  without "Leave a comment".
- **Replies are one level deep.** You can reply to a top-level comment, but not to a reply (400).
  The thread screen shows the top-level comment, then its replies; replies have a ♥ count but no
  reply count.
- **Ordering:** top-level comments come back **newest first**. Replies come back **oldest first**,
  so the thread reads as a conversation.
- **Body:** 1–2000 characters, trimmed. A body of only spaces is a 400. Keep "Post comment"
  disabled until there's text, as the Figma does.
- **Rate limit:** 60 comments per 10 minutes per person. Past that you get **429**; show "Slow
  down a little" or similar and let them retry later.
- **Deleting** a top-level comment also deletes its replies.
- **Who can delete:**
  - The **author** can delete their own comment while they can still see the club. Someone who
    left or was removed from a **private** club gets 403 for their old comments there. In a public
    club they can still delete them.
  - The **owner** can delete any comment.
  - Anyone else gets 404, so only show "Delete" in the `…` menu to the author or the owner.
- **Likes are idempotent:** liking twice is still one like, so a double tap is safe.

**Reporting a comment** (the `…` menu → Report) goes through the existing reports endpoint as a
report about the comment's author:

```
POST /api/v1/reports
{ "reportedUserId": 4412, "groupCommentId": 581, "reason": "…" }
```

You can't name both `postId` and `groupCommentId`. You can't report your own comment. A comment in
a club the reporter can't see returns 404.

---

## 6. Status codes at a glance

Errors look like `{ "error": "message", "code"?: "MACHINE_CODE" }`. Validation failures (400)
look like `{ "error": { "field": ["message"] } }`.

| Status | Meaning here |
|---|---|
| 400 | Invalid body or query, a future or out-of-order date, a reply to a reply, an empty edit |
| 401 | Not signed in, or the token expired |
| 403 | Can't see a private club's shelf, not the owner (for shelf writes), or not a member (for comment writes) |
| 404 | No such club, entry or comment, **or** it belongs to a different club than the one in the URL |
| 409 | See `code`: `CURRENT_BOOK_EXISTS`, `ALREADY_CURRENT`, `NOT_CURRENT`, `NOT_EDITABLE`, `DISCUSSION_CLOSED` |
| 429 | Comment rate limit |

---

## 7. Where the Figma and the API differ

Several frames show behaviour the API doesn't support. Here's what to build:

| Figma | Build |
|---|---|
| "Add a book" shown to a viewer who also has "Join group" (`9386:16758`) | Show it only when `canManageShelf` is true. |
| Invite notification → group page with **"Join group"** (`9386:19943`) | When `viewer.membership === "invited"`, that button must call **`POST /groups/{id}/invites/accept`**. `/join` returns 409 for an invitee. |
| Delete group: "Type 'Delete' to continue" (`9386:17469`) | Deleting a group still requires the **account password** (or a fresh Google/Apple sign-in token), as before. Use a password field, not a type-to-confirm box. |
| Remove member dialog: "Unfollow Theodore Stevens?" (`9386:17911`) | Use "Remove Theodore Stevens from the group?". Removing a member doesn't unfollow anyone. |
| A new club showing "0 users joined" | `memberCount` includes the owner, so a new club shows **1**. |
| Group report confirmation titled "Report Review" (`9386:19503`) | This reuses the review-report screen's copy; the designer has been asked to fix it. |
| Explore typeahead listing a club alongside books (`8201:9031`) | Not supported: book search returns books only. Clubs are searchable through the Groups tab (`GET /community/search?filter=groups`). |

---

## 8. Not in this release

- Notifications for bookshelf activity (a new current read, replies to your comment). None are
  designed.
- Member avatars and cover strips inside the group response: both need extra calls for now (§2).
- Approving join requests for private clubs. The copy says "invited and approved", but only
  invitations exist.
