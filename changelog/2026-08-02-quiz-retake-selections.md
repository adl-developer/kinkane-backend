# Let signed-in readers pick books after retaking the quiz

**Date:** 2026-08-02

## What changed

A reader who retakes the quiz can now save what they picked. Until today only
guests could: `POST /guest-sessions/:id/selections` handled the first run, and
after signup there was no equivalent — a Plus member could retake the quiz, get
a fresh list, and have nothing to do with it.

New endpoint, the logged-in twin of the guest one:

```
POST /api/v1/recommendations/selections
```

```json
{
  "chosenBookIds": [12, 88, 431],
  "dislikedBookIds": [57, 60]
}
```

- `chosenBookIds` — required, 1 to 5 IDs. Same bounds as the guest version; it's
  the same screen, so a retake shouldn't have different rules than a first run.
- `dislikedBookIds` — optional, additive. Books swiped away on that screen.

Returns `200` with the freshly inferred `readerType` and the chosen books
(`id`, `title`, `coverUrl`) — same response shape as the guest endpoint, so the
client can reuse its handling. Requires auth and Plus, matching `/refresh`:
this endpoint only exists to finish a retake, and only Plus members can start
one.

Unknown book IDs return `400` rather than failing on a foreign key mid-write.

## Where the guest and logged-in versions differ

The guest endpoint parks everything on the session row and waits for
registration to turn it into real state. Here there's already a user, so the
same work happens immediately, inside a transaction:

- chosen books are added to `user_books` (`source: 'chosen_from_quiz'`, liked)
  and `user_interactions` (`chosen_from_recommendation`)
- swiped-away books go straight into `user_disliked_books`

A chosen book already on the shelf keeps the status, note and source the user
gave it (`onConflictDoNothing` on both inserts). Picking a book in a quiz is not
a reason to overwrite the user's own edits — and since shelf books are now
excluded from quiz results, this should only ever fire on a stale client.

## Rejections now have a single write path

`PATCH /refresh` used to accept `dislikedBookIds` in its body. That field moved
here, and the refresh body is now **strict** — sending the old field returns
`400`.

This is a breaking change for any client already sending it, which is the point:
the failure mode of quietly ignoring it is a reader whose swipes vanish, and
they'd have no way to tell. A 400 says exactly what to fix.

`/refresh` still *returns* `dislikedBookIds` (the full accumulated set) on the
read path. Only the write moved.

## Books already on the shelf are no longer recommended

Previously `getUserExclusions` covered rejected books only, and the personalized
feed separately excluded shelf books by ID. Both sources are now merged in
`getUserExclusions`, so every surface honours both: quiz results, the
personalized feed, "you may also like", and recommendation emails.

Two behavioral consequences:

- **Shelf exclusions are now work-level.** A paperback on the shelf suppresses
  the hardback and the ebook too. Previously the feed matched on exact book ID,
  so other editions could still surface as apparent duplicates.
- **Every surface honours the shelf**, not just the feed. Quiz results in
  particular: re-offering a book the reader already owns reads as the quiz not
  knowing them.

Dislikes carry a title/author snapshot frozen at the moment of rejection; shelf
books have no such snapshot, so theirs are resolved live through the same
`resolveWorkSnapshots` helper. A shelf exclusion therefore follows catalogue
corrections, while a dislike keeps the form the user actually rejected. That
asymmetry is deliberate — a rejection is a statement about a specific thing the
user saw.

The scope is every `user_books` row regardless of `source` or `status`,
including finished books. A book they've read is not a recommendation.

## Cache invalidation

The exclusion set is Redis-cached, previously busted only on a dislike write.
It now also busts on every shelf write — `upsert`, `like`, `remove`,
`resetLibrary`, and the delete branch of `unlike`.

`unlike` only busts when it deletes the row. Clearing the liked flag on a row
that keeps a reading status leaves the book on the shelf, so the exclusion set
is unchanged.

The cache key moved to `exclusions:v2:` — v1 entries hold dislikes only and
would otherwise keep serving shelf books for up to an hour after deploy.

Note that the recommendation cache key includes `exclusions.bookIds`, so shelf
changes now change that key. Expect a lower hit rate on `/refresh?include
Recommendations=true` than before: a reader who adds a book between retakes gets
a fresh Gemini run rather than a cached list. That's the correct trade — the
cached list would contain a book they just shelved.

## Reader type

Re-inferred from the new picks and written to `user_preference_history`, but
**`users.readerType` is deliberately left unchanged**. A retake is evidence
about taste, not a decision the user made about how they want to be labelled;
the history row is where the drift becomes visible without settings changing
under them.

`fetchAndInferReaderType` moved out of `guest.service.ts` into
[lib/reader-type.ts](../src/lib/reader-type.ts) now that both quiz paths use it.
No behavior change — it's the same function, and it still never throws.

History recording is wrapped in try/catch: the snapshot is a side record, and
failing to log it must not fail a selection that's already saved.

## Out of scope

- No client changes. The app still has to call the new endpoint and drop
  `dislikedBookIds` from its refresh body.
- No backfill. Existing `user_books` rows keep whatever `source` they have;
  `chosen_from_quiz` only appears on new picks.
- `users.readerType` still has no user-facing way to change it. If a reader
  wants their label to track a retake, that's a separate decision.

## Verification

`npm test` — 80 passing, including 6 new cases in
[user-exclusions.test.ts](../src/__tests__/user-exclusions.test.ts) covering the
merge: both sources combined, shelf titles normalized the same way stored
dislikes already are, a shelf book with no known author kept as a title-only
exclusion, a book that is both shelved and rejected counted once, two editions
of one work collapsed to a single work-level entry, and the degrade-to-empty
path when the load fails.

`tsc --noEmit` clean.

Not yet exercised against a live database — the exclusion merge is covered by
mocked-db tests, and the endpoint itself has had no end-to-end run.
