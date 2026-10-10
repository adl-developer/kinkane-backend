# Bookshelf gets an Owned section

## What changed

The personal bookshelf now has five sections: **Want to read**, **Reading now**, **Finished**,
**Favourites** and the new **Owned**. A book can be in only one of the first three. Favourites and
Owned are independent, so a book can be Finished, a Favourite and Owned all at once.

- `user_books` gets two new columns: `owned` (boolean, default false) and `owned_at` (migration
  `0075_shelf_owned`). Existing rows start as not owned, so no backfill is needed.
- `PUT /user-books/:bookId` accepts `owned`, and now also `status: null` to take a book out of the
  three reading sections.
- New `POST` and `DELETE /user-books/:bookId/own`, mirroring like/unlike.
- `GET /user-books?owned=true` lists the Owned section. List items and the book page's
  `userStatus` include `owned` (list items also include `ownedAt`).
- `GET /users/:id/books` accepts `filter=liked` and `filter=owned`, and its items carry `liked`
  and `owned`.

## Why

The client asked for an Owned section that behaves like Favourites. They also asked that the picker
let people choose Want to read **or** Reading now **or** Finished, **and** optionally Favourites,
**and** optionally Owned. The three reading states were already one column, so they were already
exclusive. Favourites already existed as `liked`. Owned is a second flag of the same kind.

## Decisions

- **One rule for when an entry is deleted.** An entry stays while it holds anything: a reading
  status, either flag, or a note. It's deleted the moment it holds nothing. Unlike, un-own and
  `PUT status:null` all go through this rule. It's a single conditional `DELETE`, so two toggles
  landing at once (unlike on one device, mark Owned on another) can't lose a book that's still
  owned.
- **A note now keeps an entry.** Before, unliking a book with no status deleted the entry, note and
  all. Clearing the last flag shouldn't silently throw away something the reader wrote.
- **Clearing a status needed `null`.** The old `PUT` only accepted one of the three statuses, so
  there was no way to untick "Reading now" and keep the book as Owned.
- **Owned adds no trending or recommendation signal.** Owning a copy says nothing about whether you
  liked it, and gifts or secondhand piles would skew the "readers like you" feed. Owned books *are*
  excluded from recommendations, like every shelf book.
- **`ownedAt` and `likedAt` keep the first date.** Marking a book Owned (or a Favourite) again is
  a no-op, not a new event. This also changes `likedAt`, which used to move on every re-like, so the
  two flags behave the same.
- **Flag changes don't rewrite `source`.** `source` records how the book got onto the shelf (quiz
  pick, onboarding, manual), and the "readers like you" cohort reads it. Before, liking a quiz pick
  overwrote it with `manual` and dropped the pick from the cohort. Owning would have done the same.
  Like, own, and a `PUT` that only sets `liked`/`owned` now leave it alone. Status and note edits
  still mark the entry `manual`, as before.
- **A whitespace-only note is no note.** It's saved as `null`. The emptiness check also treats
  whitespace as empty, using the ICU collation because the database's C ctype makes `[[:space:]]`
  ASCII-only.
- **Plus gating copies Favourites.** Adding needs Plus. Removing is free, including a `PUT` whose
  body only clears fields (`status: null`, `owned: false`, …). Without that, a lapsed member could
  only drop a reading status by deleting the whole entry, along with its Favourite, Owned and note.
- **`liked` keeps its name** in the API. It's the Favourites section, and renaming it would break
  current clients.

## Out of scope

- Automatically marking a book Owned when it's bought through the Kinkané shop.
- A count-per-section endpoint.
- Group bookshelves. They have no Favourites or Owned.

## Verification

- New `shelf-owned.integration.test.ts` runs against a scratch Postgres. It covers: a book in
  Finished + Favourites + Owned at once; moving between statuses without touching the flags;
  `status: null` keeping an Owned book and removing an otherwise empty one; never creating an empty
  entry; own/unown; the original `ownedAt` surviving a repeat; unlike/unown keeping entries that
  still hold something, including a note; and the public shelf's `liked` and `owned` filters.
- The full unit suite and every integration suite pass.
