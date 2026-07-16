# TODO

## Decide which surfaces should hide `is_removed` books

**Added:** 2026-07-16, following [changelog/2026-07-16-books-soft-delete.md](changelog/2026-07-16-books-soft-delete.md)

### The problem

`books.is_removed` / `books.removed_at` were added so that `onix_ingester`
can mark a book withdrawn (Gardners' ONIX "delete" notifications) without
hard-deleting the row — hard-deleting used to cascade to a user's posts,
reading-list entries, and interaction history for that book (see the
changelog entry above for the full FK breakdown).

That fix only stops the *destruction*. It does nothing about *visibility* —
no query in this repo currently reads `is_removed`, so a withdrawn book
still shows up everywhere it did before: search, browse, trending,
recommendations, autocomplete, "similar books," and recommendation emails.
Gardners' periodic full-catalogue re-syncs (`onix_ingester`'s
`POST /gardners/bootstrap`, meant to be re-run every few months per the
current plan) will produce a batch of these withdrawals each time it runs,
so this isn't a rare edge case to defer indefinitely — it'll surface
concretely the first time that re-sync actually removes something a real
user has interacted with.

The reason this is a TODO and not just fixed alongside the schema change:
which surfaces should hide a removed book and which should keep showing it
isn't a mechanical question — a user's own reading-list entry for a book
that's since been withdrawn should probably *not* disappear (they already
own/read it), but recommending that same withdrawn book to a *different*
user clearly should stop. Getting this wrong in either direction is a
product/UX call, not something to guess at silently.

### Suggested solution

Add a `notInArray`-style condition (`eq(books.isRemoved, false)` /
`isNull` equivalent — `isRemoved` is `notNull().default(false)` so a plain
`eq(books.isRemoved, false)` is sufficient, no null-handling needed) to
each query below that should exclude removed books. Concretely, split into
two groups:

**Should exclude removed books** (discovery/recommendation surfaces — a
removed book showing up here is a real bug, since the reader may not even
be able to obtain it anymore):

- `src/services/books.service.ts`
  - `list()` → add the condition inside `buildWhereClause()` (~line 216) so
    it applies to both the row query and the count query in one place.
  - `suggestions()` → `buildSearchCondition()` / `buildAuthorBookSearchCondition()`
    (~lines 139, 173) — autocomplete shouldn't suggest a withdrawn title.
  - `trending()` (~line 554) — a withdrawn book shouldn't trend.
  - `personalized()` (~line 656) — shouldn't be recommended.
  - `similar()` (~line 743) — shouldn't appear as a "similar book."
- `src/services/recommendations.service.ts`
  - The two vector-similarity pool queries (~lines 249 and 480, both
    `db.select(...).from(books).where(whereClause of embedding <=>
    similarity)`) — add `isRemoved = false` to `whereClause` in both places.
    This is the core recommendation engine; the highest-priority fix in
    this whole list.
- `src/services/recommendation-notifications.service.ts`
  - `pickUnsentRecommendation()` (~line 33) — don't email-recommend a
    withdrawn book.
- Lower priority, more debatable — decide alongside the above:
  - `src/services/community.service.ts` `createPost()` (~line 233) — should
    a user be able to start a *new* review of a book that's since been
    withdrawn? Leaning toward no, but low-frequency enough to punt on.
  - `src/services/user-books.service.ts` `upsert()` (~line 232) and
    `like()` (~line 289) — should adding a withdrawn book to your reading
    list or liking it going forward be blocked? Same reasoning as above.

**Should explicitly NOT filter** (resolving books a user has already
engaged with — these need to keep working exactly as they do today, or a
past interaction silently breaks):

- `src/services/books.service.ts` `getById()` (~line 474) — the book detail
  page. My suggestion: don't 404, but include `isRemoved`/`removedAt` in
  the response so the frontend can render a "no longer available" state
  instead of a broken/blank page for a book a user already has in their
  library or is revisiting via an old link.
- `src/services/community.service.ts` — the post-enrichment query (~line
  689) that attaches book info (title/cover/isbn13) to an *existing* post
  for display. Needs to keep resolving so old reviews keep rendering with
  the book's last-known details.
- `src/services/recommendations.service.ts` `fetchLikedBooks()` (~line 71)
  — resolves titles/authors for books the user has *already* liked, to
  build their preference profile. Historical, not discovery.
- `src/services/guest.service.ts` `fetchAndInferReaderType()` (~line 17)
  and the chosen-books fetch in the onboarding flow (~line 114) — resolves
  specific already-chosen bookIds from onboarding. Historical.
- `src/services/auth.service.ts` `generatePreferenceEmbedding()` (~line 71)
  — same pattern as above, resolving already-chosen onboarding books.

### Not investigated

- `authorSuggestions()` in `books.service.ts` queries `book_contributors`
  directly, not `books` — an author's book-count could include removed
  titles. Minor, probably not worth a join just for the count to be exact.
- Whatever admin/internal tooling (if any) manages the catalogue directly
  wasn't audited — this list only covers the 7 files under `src/services/`
  that query `books` today.
