# Bookshelf: Owned section, and clearing a reading status — client brief

**Audience:** whoever builds the personal bookshelf and the "add to shelf" picker.
**Status:** on `feat/shelf-owned`, not merged or deployed. Needs migration `0075_shelf_owned`
(two new columns, no backfill).

All paths are under `/api/v1`, and every call needs a signed-in user
(`Authorization: Bearer <access token>`). The field-by-field contract is in the OpenAPI spec at
`GET /openapi.json`, under **Library** and **People**. **If this document and the spec disagree,
the spec is correct.**

---

## Checklist

- [ ] **Shelf tabs:** add an **Owned** tab next to Favourites. See [§2](#2-listing-each-section).
- [ ] **Picker:** three options you can pick one of (or none), plus two independent toggles. See
      [§3](#3-the-picker).
- [ ] **Unticking a status:** send `status: null`. Before this change there was no way to do it.
- [ ] **Other readers' shelves:** add Favourites and Owned tabs. See [§4](#4-someone-elses-shelf).

---

## 1. The rule

The shelf has five sections:

| Section       | Field                   | Can share a book with…              |
|---------------|-------------------------|-------------------------------------|
| Want to read  | `status: "want_to_read"`| Favourites, Owned                   |
| Reading now   | `status: "reading"`     | Favourites, Owned                   |
| Finished      | `status: "read"`        | Favourites, Owned                   |
| Favourites    | `liked: true`           | everything                          |
| Owned         | `owned: true` **(new)** | everything                          |

The first three are one field, so a book is only ever in one of them. Favourites and Owned are
separate yes/no flags on top. A book can be Finished, a Favourite and Owned all at the same time.

`liked` keeps its name in the API for backwards compatibility. It's the Favourites section.

## 2. Listing each section

`GET /user-books` takes one filter per section:

- `?status=want_to_read`, `?status=reading`, `?status=read`
- `?liked=true`: Favourites
- `?owned=true`: Owned **(new)**

Each book in the response now carries `owned` and `ownedAt` alongside `liked` and `likedAt`.
`GET /books/{id}`'s `userStatus` (your entry for that book) also has `owned`.

## 3. The picker

Send whatever changed. Every field is optional, and anything you leave out stays as it is.

```http
PUT /user-books/48213
{ "status": "read", "liked": true, "owned": true }
```

- **Choosing a different status** replaces the old one: `{ "status": "reading" }`.
- **Unticking the status** while keeping the book in Favourites or Owned: `{ "status": null }`.
  **New.** `null` used to be rejected.
- **Toggling Owned on its own:** `POST /user-books/{bookId}/own` and `DELETE /user-books/{bookId}/own`
  **(new)**. They mirror the existing `/like` endpoints, and `PUT` with `owned` does the same thing.

**When a book leaves the shelf.** If a change leaves the book with no status, not a Favourite, not
Owned and no note, the server deletes the entry. You don't need to call `DELETE` yourself. After
any of these calls, re-read the entry (or the list) rather than assuming it's still there.

Behaviour changes you might notice:

- Unliking a book with no status used to delete it even if it had a note. Now the note keeps it on
  the shelf. A note of only spaces or blank lines counts as no note, and is saved as `null`.
- `likedAt` and `ownedAt` are the first time the flag was set. Setting it again, e.g. by re-sending
  the whole picker state on save, doesn't move the date. Before this change, every re-like moved
  `likedAt`.

**Plus.** Adding to the shelf (`PUT`, `POST …/own`, `POST …/like`) needs Kinkané Plus, as before.
Removing stays free, so a lapsed member can still tidy up:

- `DELETE …/own`, `DELETE …/like` and `DELETE /user-books/{bookId}`
- a `PUT` whose body only clears things: `status: null`, `liked: false`, `owned: false`,
  `noteIsPublic: false`, `note: null`

A `PUT` that mixes clearing with adding (e.g. `{ "status": null, "owned": true }`) still needs Plus.

**Response.** `PUT` returns `{ "success": true }`, not the entry. Re-read it.

## 4. Someone else's shelf

`GET /users/{userId}/books?filter=…` now also accepts `filter=liked` (Favourites) and
`filter=owned`. Each item carries `liked` and `owned`. The usual `shelfVisibility` rules apply:
anyone who can see the shelf can see what's Owned.

## 5. Not in this change

- Buying a book through the Kinkané shop doesn't mark it Owned automatically yet.
- There's no endpoint returning a count per section.
- Group bookshelves are unchanged. They have no Favourites or Owned.
