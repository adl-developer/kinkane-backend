# Preference history can be read one section at a time

## What changed

The app's new preference screens each have their own History tab: one for
mood, one for genres, one for what to avoid. Each lists the dates that section
changed and opens a read-only view of it on that date.

`GET /api/v1/user/preference-history` returned every change mixed together, so
the app would have had to fetch everything and filter on the phone. It now
takes an optional `field` query parameter:

```
GET /api/v1/user/preference-history?field=genres
```

| Screen | `field` |
| --- | --- |
| Mood preferences → History | `feelings` |
| Genre preferences → History | `genres` |
| What to avoid → History | `dislikes` |

`bookIds`, `dislikedBookIds` and `readerType` are also accepted; the filter works
the same for any field `changedFields` can name. Anything else is a `400`.

Each entry is still a full snapshot, so the detail screen ("Your genre
preferences on August 10, 2026") reads straight from the entry the reader
tapped. No second request.

Entries also now include `dislikedBookIds`. It was recorded all along and
dropped from the response.

## Decisions worth knowing about

**The first entry is in every section's list.** The signup snapshot (and the
backfill row for accounts older than the history table) has an empty
`changedFields`, because nothing changed relative to an earlier row. It is,
though, when every field was first set. Leaving it out would give a reader who
has never edited their genres an empty genre history, which reads as a bug.

**Filtered in SQL, not in the app.** Filtering on the phone makes `total` and
`hasMore` describe the unfiltered list. A page of 20 could hold two genre
changes and say there are more. With the filter in the query, paging counts
the list the reader actually sees.

**`@>` instead of the jsonb `?` operator.** `?` can be mistaken for a bind-
parameter placeholder by Postgres drivers. `changed_fields @> '["genres"]'` asks
the same question safely. No new index: a reader's history is a handful of rows
already narrowed by the `(user_id, recorded_at)` index.

## Out of scope

- **Splitting the free-text mood prompt from the preset moods.** The design
  shows the prompt plus three moods. We store three `feelings` in total, and a
  free-text answer takes one of those slots. The server has no list of preset
  mood labels (feelings are deliberately open, and the labels belong to the
  app), so it can't tell which entry is the prompt. The app can, by checking
  each entry against its own mood list. Whether the prompt should become a
  fourth input is a design question.
- **The History screen's `…` menu.** The design doesn't say what it does. If it
  becomes "clear history", that needs a new endpoint.

## Verification

- `npm test`: 1036 passing, including 7 new cases in
  [preference-history.test.ts](../src/__tests__/preference-history.test.ts). The
  filter is rendered through the real Postgres dialect and checked for the
  user scope, the `@>` match with the right parameter, the baseline-row
  clause, and the `OR` staying inside the `AND`. If the `OR` escaped its
  parentheses, every user's baseline row would be returned. The query schema
  is tested for accepting the three section fields, rejecting unknown ones,
  and leaving `field` unset by default.
- `tsc --noEmit` clean.
- Not run against a live database.
