# Dislikes accept whatever the onboarding screen sends

## What changed

The `dislikes` object on the onboarding and preference-refresh endpoints is no
longer validated against a fixed list of categories and labels. Any category key
mapping to an array of label strings is now accepted:

```json
"dislikes": {
  "emotionalTone": ["too dark or heavy", "sad or tragic ending"],
  "contentSensitivity": ["graphic violence", "explicit content", "triggering themes"],
  "pacingStructure": ["slow paced"],
  "commitmentLevel": ["long book (500+ pages)", "series commitment"]
}
```

Affected endpoints: `POST /recommendations` and `POST /recommendations/refresh`.

## Why

The schema previously hardcoded five categories and enumerated every allowed
label inside them (`z.enum(['too dark or heavy', ...])`). The onboarding screen
has since added a **Content Sensitivity** group (graphic violence, explicit
content, triggering themes), which the API would have rejected outright — a
single unrecognised label failed the entire request rather than degrading
gracefully. Since these categories and their wording are UI copy and change
whenever the onboarding flow is redesigned, keeping a mirror of them in the
backend meant a server release for every copy tweak, and a window where the two
were out of sync and onboarding was broken.

## Data shape

`Dislikes` went from a five-field interface to `Record<string, string[]>`
(`server/src/db/schema/onboarding.ts`). The stored jsonb is unchanged in
structure, so existing `guest_sessions.dislikes` and
`user_preferences.dislikes` rows remain valid and no migration was needed.

## Non-obvious decisions

- **Categories are ignored by the pipeline.** Everywhere dislikes are consumed —
  the cache hash, the preference text that gets embedded, and the SQL filters —
  they are flattened to a single list of labels via a new `flattenDislikes`
  helper. The category keys exist only for the UI's grouping. A consequence
  worth knowing: if the frontend moves a label from one group to another, it is
  still the same preference and still hits the same cache entry.
- **The two hard SQL filters were kept.** `"long book (500+ pages)"` and
  `"series commitment"` are the only labels with a real column-level filter
  (`page_count < 500`, and a series-numbering exclusion on title/subtitle);
  everything else influences results only through the preference embedding.
  These are now matched anywhere in the object rather than under
  `commitmentLevel`, so regrouping them in the UI is safe. They are still exact
  string matches, though — **rewording either label in the frontend silently
  turns its filter off**, with no error. That tradeoff was accepted rather than
  fuzzy-matching, which would have made it unclear when a filter applies.
- **Length caps stayed.** Category keys are capped at 100 characters and each
  label at 200, matching the existing cap on freeform feelings, because every
  label ends up in the text sent to the embedding model.
- **The cache hash changed shape** (a flat sorted array instead of five sorted
  fields), so previously cached recommendations miss once and are recomputed.
  Entries expire after 48h anyway.

## Out of scope

- The genre list (`GENRE_VALUES`) and its fiction/non-fiction bucketing are
  still a closed enum — those drive a format filter that depends on knowing each
  value, so opening them is a separate piece of work.
- No per-category or total item-count limit was added; only the length caps.

## Verification

`npx tsc --noEmit` clean, and `npm test` passes (31 tests). Added
`src/__tests__/dislikes.test.ts` covering: unknown category keys accepted,
labels outside the old presets accepted, empty object accepted, non-array values
and over-length labels still rejected, and `buildPreferenceText` including
labels from unrecognised categories. The Postman collection samples were updated
to include a `contentSensitivity` group.
