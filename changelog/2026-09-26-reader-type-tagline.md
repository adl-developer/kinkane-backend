# Return each reader type's tagline alongside it

**Date:** 2026-09-26
**Branch:** `feat/reader-type-taglines`

## What changed

Each of the eight reader types now has a one-line tagline, taken from the
product sheet "Kinkané App Reader Types". Every endpoint that returns a reader
type now returns its tagline in a new `readerTypeTagline` field next to it:

| Endpoint | Where the app shows it |
| --- | --- |
| `POST /api/v1/guest-sessions/{id}/selections` | Onboarding result |
| `POST /api/v1/recommendations/selections` | Quiz retake result |
| `GET /api/v1/user/settings` | Profile and settings |
| `GET /api/v1/explore/reader-type` | "Readers like you loved" rail heading |

```json
{
  "readerType": "The Echo Collector",
  "readerTypeTagline": "Thoughtful; stories linger and accompany you on your journey."
}
```

`readerTypeTagline` is `null` exactly when `readerType` is. The change only
adds fields, so existing app builds are unaffected.

The rail endpoint also gains a `readerType` field of its own: the cohort it was
built from, which is the `readerType` query parameter if one was sent, otherwise
the caller's own. It's returned even when `books` is empty.

## Decisions

- **Stored in code, not the database.** The taglines live in
  [reader-type-taglines.ts](../src/lib/reader-type-taglines.ts) as a
  `Record<ReaderType, string>`. The reader type enum is already a code-and-
  migration change, so a table would add a lookup without making anything
  editable that isn't already gated on a deploy. Keying the map by the enum
  means a new reader type won't compile until it has a tagline.
- **A sibling field, not an object.** Changing `readerType` to
  `{ name, tagline }` would be tidier, but it would break every client that
  reads it as a string.
- **No fallback copy.** A reader with no type gets `null`, not a generic line.
- **The rail says which cohort it read.** Without this, a tagline on the rail
  would have nothing to attach to: when a signed-out visitor or a preview names
  a cohort, the app has no reader type of its own to title the rail with.
- **Copy fixes.** "Emphatic" became "empathic", stray whitespace was trimmed,
  and The Open Door got the full stop the other seven have. The sheet's "The
  Seeker or The Committed Seeker" maps to the existing enum value "The Seeker".

## Docs corrected along the way

- The spec documented `POST /guest-sessions/{id}/selections` as returning
  `{ ok: true }`. It has returned `{ readerType, books }` since reader type
  inference was added to it. The spec and the route comment now show the real
  shape.
- The spec for `GET /user/settings` listed only `shelfVisibility`. It now also
  lists `name`, `photoUrl` and `readerType`, which the endpoint already
  returned.

App-facing guidance is in
[reader-type-taglines-client-brief.md](../docs/reader-type-taglines-client-brief.md).

## Out of scope

- `GET /users/{userId}` (another reader's profile) doesn't return a reader type,
  though the `UserProfile` schema in the spec lists one. That mismatch is left
  as it was.
- The first onboarding request, `POST /recommendations`, has no picks to infer a
  type from, so it returns neither field.

## Testing done

- New unit test
  [reader-type-taglines.test.ts](../src/__tests__/reader-type-taglines.test.ts):
  every enum value has a non-empty, trimmed tagline, and a missing type gives
  `null`.
- Updated the source-text assertion in `reader-type-feed.test.ts` for the
  rail's new empty-cohort return value.
- Typecheck is clean and the full unit suite passes (1,054 tests). The endpoint
  contract suite passed in the pre-commit hook.
- The endpoints weren't called against a running server.
