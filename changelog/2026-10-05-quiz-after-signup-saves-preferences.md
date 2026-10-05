# Quiz answers now save for readers who signed up before taking it

## What changed

A reader who created an account first and took the quiz afterwards had their
answers silently thrown away. Their personalized feed (`GET /explore/personalized`)
came back empty, and `GET /recommendations/preferences` returned 404, even
though the quiz looked like it had saved.

The save behind `PATCH /recommendations/refresh` now creates the reader's
preferences if they don't exist yet, rather than only updating an existing record.
The nine readers already affected have been restored.

## Why it happened

A reader's preferences record was only ever created in one place: when a
guest's onboarding quiz session is turned into an account at registration.
Signing up first skips that step, so no record exists.

Taking the quiz later goes through `PATCH /refresh`, which saved with a plain
`UPDATE ... WHERE user_id = ?`. With no record, that matched zero rows and
raised no error, so the endpoint returned 200. The embedding regeneration that
follows it updated nothing for the same reason, and the personalized feed
returns `[]` whenever there is no embedding.

The rest of the retake did save. `POST /selections` writes to `users` and
`user_books`, so these readers had a reader type and shelf books but no
preferences, which made the problem easy to miss.

## The fix

`saveUserPreferenceFields` now inserts the record and updates it on a conflict
on `user_id`. The update deliberately leaves out `preference_embedding`, so a
reader who already has an embedding keeps being served from it until the
background regeneration replaces it. That matches the existing behaviour.
`regeneratePreferenceEmbedding` stays a plain update; it always runs after the
save, so the record exists by then.

## Backfill

`scripts/backfill-missing-preferences.ts` (`--dry-run` to list only).

The preference history write in the same path is an INSERT, so it *did* land.
Each affected reader's latest `user_preference_history` row holds exactly the
answers the lost save should have written, and the script restores from it.
It only touches readers with no preferences record, inserts with
`ON CONFLICT DO NOTHING`, and builds the embedding through the same
`regeneratePreferenceEmbedding` the refresh path uses, which also clears the
reader's cached feed. It is safe to re-run.

It ran on 2026-10-05 against the database in `server/.env` and restored nine readers:
users 135, 136, 152, 153, 154, 208, 210, 211 and 215.

## Out of scope

- No schema change: `user_preferences.user_id` was already unique, which is
  what the upsert targets.
- The registration path (`auth.service.ts`) still updates the embedding with
  a plain update. That is correct there, because it runs right after inserting the record.

## Testing done

- `npm test`: 78 files, 1255 tests passing; `tsc --noEmit` clean.
- After the backfill, `booksService.personalized(id, 10)` returns 10 books for
  each of the nine readers (all returned `[]` before).
