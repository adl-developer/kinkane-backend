# Onboarding accepts any number of genres

**Date:** 2026-10-07

## What changed

The `genres` field on the onboarding recommendation request (and on refresh,
which shares the same rules) no longer has a maximum. It previously allowed
up to 3, and before that it required exactly 3 from a fixed list of 21
genres.

## Data shape

```
genres: string[]   // at least 1, no maximum, each 1-100 characters (trimmed)
```

Any genre name is accepted. The fixed list was removed in the previous
release, because a new chip in the app (e.g. "contemporary fiction") failed
the whole request.

## Decisions

- **At least one genre is still required.** Genres feed the preference text
  the recommendations are built from, and an empty list gives the search
  nothing to go on.
- **Each genre is capped at 100 characters.** Every genre is written into
  the text that gets embedded, so the length cap stays.

## Verification

Type check passes. The API docs (`onboarding.ts`) now describe "one or more
genre labels, with no upper limit."
